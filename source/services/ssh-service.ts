import {Client} from 'ssh2';
import {ISSHService} from './service-interfaces.js';

export interface SSHConfig {
    host: string;
    port: number;
    username: string;
    agent?: string;
}

export class SSHService implements ISSHService {
    private client: Client;
    private connected: boolean = false;

    constructor(private config: SSHConfig, client?: Client) {
        this.client = client ?? new Client();
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client
                .on('ready', () => {
                    this.connected = true;
                    resolve();
                })
                .on('error', (err) => {
                    this.connected = false;
                    reject(err);
                })
                .on('end', () => {
                    this.connected = false;
                })
                .connect(this.config);
        });
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            this.client.end();
            this.connected = false;
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    async executeCommand(cmd: string, opts?: { cwd?: string }): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
    }> {
        if (!this.connected) {
            throw new Error('SSH client not connected');
        }

        return new Promise((resolve, reject) => {
            // If cwd is provided, wrap command to change directory first
            // We use simple string concatenation. In a more robust system we might want to escape the cwd path.
            const commandToExec = opts?.cwd
                ? `cd "${opts.cwd}" && ${cmd}`
                : cmd;

            this.client.exec(commandToExec, (err, stream) => {
                if (err) return reject(err);

                let stdout = '';
                let stderr = '';

                stream.on('close', (code: number) => {
                    resolve({
                        stdout,
                        stderr,
                        exitCode: code, // code is null if terminated by signal
                        timedOut: false
                    });
                }).on('data', (data: Buffer) => {
                    stdout += data.toString();
                }).stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
            });
        });
    }

    async readFile(path: string): Promise<string> {
        const result = await this.executeCommand(`cat "${path}"`);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to read file ${path}: ${result.stderr}`);
        }
        return result.stdout;
    }

    async writeFile(path: string, content: string): Promise<void> {
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
        const cmd = `cat > "${path}" << '${delimiter}'\n${content}\n${delimiter}`;

        const result = await this.executeCommand(cmd);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to write file ${path}: ${result.stderr}`);
        }
    }

    async mkdir(path: string, opts?: {recursive?: boolean}): Promise<void> {
        const flags = opts?.recursive ? '-p' : '';
        const result = await this.executeCommand(`mkdir ${flags} "${path}"`);
        if (result.exitCode !== 0) {
             throw new Error(`Failed to mkdir ${path}: ${result.stderr}`);
        }
    }
}
