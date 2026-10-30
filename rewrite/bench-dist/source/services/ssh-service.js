import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { homedir } from 'os';
/**
 * Typed transport settlement for a remote command. Replacing raw/unclassified
 * rejections lets callers and recovery paths distinguish a local containment
 * decision (`'aborted'`, `'timeout'`, `'not_connected'`) from an ambiguous
 * transport drop without guessing at message text.
 */
class SSHTransportError extends Error {
    kind;
    remoteEffect;
    /** Bytes received before settlement. Best effort only — never a complete result. */
    partialOutput;
    constructor(kind, message, options = {}) {
        super(message);
        this.name = 'SSHTransportError';
        this.kind = kind;
        this.remoteEffect = options.remoteEffect ?? 'unknown';
        this.cause = options.cause;
        this.partialOutput = options.partialOutput;
    }
}
/**
 * Canonical POSIX single-quote escaping: the value is wrapped in single quotes
 * and any embedded `'` is rewritten as `'\''` (close quote, escaped quote,
 * reopen quote). Shell metacharacters, `$VAR`, `$(...)`, and operators inside
 * the value become inert data. Applies to every remote path argument and the
 * optional `cwd`.
 */
export function quoteShellArg(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function transportDropMessage(kind, cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    switch (kind) {
        case 'connection_error':
            return `SSH connection error${detail}`;
        case 'connection_end':
            return 'SSH connection ended while a command was in flight';
        case 'connection_close':
            return 'SSH connection closed while a command was in flight';
        case 'channel_error':
            return `SSH channel error${detail}`;
        case 'explicit_disconnect':
            return 'SSH connection disconnected while a command was in flight';
        case 'exec_failed':
            return `SSH exec failed${detail}`;
        case 'aborted':
            return 'SSH command aborted';
        case 'timeout':
            return 'SSH command timed out';
        case 'not_connected':
            return 'SSH client not connected';
    }
}
/**
 * Owns the SSH transport lifecycle and remote command execution.
 *
 * Connection-state listeners are attached exactly once per client instance
 * (`attachLifecycleListeners`), so repeated `connect()` calls cannot stack
 * handlers. `connect()` is single-flight: an in-progress attempt is shared and
 * a call while already connected is a no-op, so an old connection era's
 * listeners can never settle a later command. Keepalive policy is explicitly
 * **none** — no keepalive configuration and no background pings; drops are
 * detected by socket/stream events and reported through typed settlement.
 *
 * Every in-flight `executeCommand` registers a settler in
 * `activeCommandSettlers`. A terminal connection event settles all active
 * commands with a typed `SSHTransportError`; each command also settles on its
 * own stream close, channel error, `timeoutMs` elapse, or abort signal. The
 * promise never hangs on a dropped transport.
 */
export class SSHService {
    config;
    client;
    connected = false;
    lifecycleAttached = false;
    connecting = null;
    /** Settlers for commands currently in flight; a terminal transport event settles them all. */
    activeCommandSettlers = new Set();
    constructor(config, client) {
        this.config = config;
        this.client = client ?? new Client();
    }
    /**
     * Attaches connection-level lifecycle listeners once per client instance.
     * The first terminal event (`error`/`end`/`close`) wins per era: after the
     * first drop the connection is marked down and every command active at that
     * moment settles; later events from the same close sequence find an empty
     * active set.
     */
    attachLifecycleListeners() {
        if (this.lifecycleAttached)
            return;
        this.lifecycleAttached = true;
        this.client.on('error', (err) => this.onTransportDrop('connection_error', err));
        this.client.on('end', () => this.onTransportDrop('connection_end'));
        this.client.on('close', () => this.onTransportDrop('connection_close'));
    }
    onTransportDrop(kind, cause) {
        this.connected = false;
        const settlers = Array.from(this.activeCommandSettlers);
        this.activeCommandSettlers.clear();
        for (const settle of settlers) {
            settle(kind, cause);
        }
    }
    async connect() {
        if (this.connected)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = this.performConnect().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }
    async performConnect() {
        return new Promise((resolve, reject) => {
            this.attachLifecycleListeners();
            // Build connection config, including private key if identity file specified
            const connectConfig = {
                host: this.config.host,
                port: this.config.port,
                username: this.config.username,
                agent: this.config.agent,
            };
            if (this.config.identityFile) {
                try {
                    // Expand ~ to home directory
                    const keyPath = this.config.identityFile.replace(/^~/, homedir());
                    connectConfig.privateKey = readFileSync(keyPath);
                }
                catch (err) {
                    reject(new Error(`Failed to read identity file: ${err.message}`));
                    return;
                }
            }
            // Per-attempt listeners are `once` and each removes the other on
            // settlement, so repeated connect attempts never accumulate handlers.
            let settled = false;
            const onReady = () => {
                if (settled)
                    return;
                settled = true;
                this.client.removeListener('error', onError);
                this.connected = true;
                resolve();
            };
            const onError = (err) => {
                if (settled)
                    return;
                settled = true;
                this.client.removeListener('ready', onReady);
                this.connected = false;
                reject(err);
            };
            this.client.once('ready', onReady);
            this.client.once('error', onError);
            this.client.connect(connectConfig);
        });
    }
    async disconnect() {
        if (this.connected) {
            this.connected = false;
            this.onTransportDrop('explicit_disconnect');
            this.client.end();
        }
    }
    isConnected() {
        return this.connected;
    }
    async executeCommand(cmd, opts) {
        if (!this.connected) {
            throw new SSHTransportError('not_connected', 'SSH client not connected', { remoteEffect: 'none' });
        }
        const signal = opts?.signal;
        if (signal?.aborted) {
            throw new SSHTransportError('aborted', 'SSH command aborted before dispatch', {
                cause: signal.reason,
                remoteEffect: 'none',
            });
        }
        return new Promise((resolve, reject) => {
            // cwd and file paths are treated strictly as data: canonical POSIX
            // single-quote escaping keeps quotes, $VAR, $(...), and shell operators
            // from breaking out of the command string.
            const commandToExec = opts?.cwd ? `cd ${quoteShellArg(opts.cwd)} && ${cmd}` : cmd;
            const timeoutMs = opts?.timeoutMs;
            let settled = false;
            let stream = null;
            let timeoutHandle;
            let stdout = '';
            let stderr = '';
            // Each command builds its own typed drop error so the settlement carries
            // that command's own partial output and message.
            const settleOnTransportDrop = (kind, cause) => rejectWith(kind, transportDropMessage(kind, cause), { cause, remoteEffect: 'unknown' });
            const onAbort = () => rejectWith('aborted', 'SSH command aborted', { cause: signal?.reason });
            const onStreamClose = (code) => {
                settle(() => resolve({ stdout, stderr, exitCode: code, timedOut: false }));
            };
            const onStdout = (chunk) => {
                stdout += chunk.toString();
            };
            const onStderr = (chunk) => {
                stderr += chunk.toString();
            };
            const onStreamError = (err) => rejectWith('channel_error', `SSH channel error: ${err.message}`, { cause: err });
            const cleanup = () => {
                this.activeCommandSettlers.delete(settleOnTransportDrop);
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                if (stream) {
                    stream.removeListener('close', onStreamClose);
                    stream.removeListener('data', onStdout);
                    stream.removeListener('error', onStreamError);
                    stream.stderr.removeListener('data', onStderr);
                }
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            };
            function settle(fn) {
                if (settled)
                    return;
                settled = true;
                cleanup();
                fn();
            }
            function rejectWith(kind, message, options) {
                settle(() => reject(new SSHTransportError(kind, message, { ...options, partialOutput: { stdout, stderr } })));
            }
            this.activeCommandSettlers.add(settleOnTransportDrop);
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            if (timeoutMs !== undefined && timeoutMs > 0) {
                timeoutHandle = setTimeout(() => {
                    timeoutHandle = undefined;
                    rejectWith('timeout', `SSH command timed out after ${timeoutMs}ms`);
                }, timeoutMs);
            }
            this.client.exec(commandToExec, (err, channel) => {
                if (settled)
                    return;
                if (err) {
                    rejectWith('exec_failed', `SSH exec failed: ${err.message}`, { cause: err });
                    return;
                }
                stream = channel;
                stream.on('close', onStreamClose);
                stream.on('data', onStdout);
                stream.on('error', onStreamError);
                stream.stderr.on('data', onStderr);
            });
        });
    }
    async readFile(path) {
        const result = await this.executeCommand(`cat ${quoteShellArg(path)}`);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to read file ${path}: ${result.stderr}`);
        }
        return result.stdout;
    }
    async writeFile(path, content) {
        // We use a heredoc with a delimiter that is unlikely to be in the content.
        // A unique delimiter helps avoid conflicts.
        const delimiter = 'TERM2_EOF_' + Date.now();
        // We need to be careful about newlines and shell escaping.
        // The safest way to write arbitrary content via shell without scp/sftp is complex.
        // However, for text files, heredoc is usually fine.
        // We must ensure the delimiter doesn't appear in the content.
        if (content.includes(delimiter)) {
            throw new Error('Content contains internal delimiter');
        }
        // We use cat with a quoted heredoc 'EOF' to prevent variable expansion in the content
        const cmd = `cat > ${quoteShellArg(path)} << '${delimiter}'\n${content}\n${delimiter}`;
        const result = await this.executeCommand(cmd);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to write file ${path}: ${result.stderr}`);
        }
    }
    async mkdir(path, opts) {
        const flags = opts?.recursive ? '-p' : '';
        const result = await this.executeCommand(`mkdir ${flags} ${quoteShellArg(path)}`);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to mkdir ${path}: ${result.stderr}`);
        }
    }
}
//# sourceMappingURL=ssh-service.js.map