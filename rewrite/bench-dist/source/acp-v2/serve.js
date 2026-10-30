import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpV2Agent } from './agent.js';
import { createAcpV2SessionBackend } from './session-backend.js';
import { parseAcpArgs } from './serve-args.js';
import { getAllProviders, getProviderIds } from '../providers/index.js';
import { installationVersion } from '../providers/fetch/logging-middleware.js';
import { resolveModelFlag } from '../services/models/model-resolution.js';
import { buildEnvOverrides, SettingsService } from '../services/settings/settings-service.js';
import { createServeSessionLogWiring } from '../gateway/serve.js';
import { createProductionRuntimeFactory } from '../gateway/runtime-factory.js';
import { getDefaultShellSandboxRunner } from '../utils/shell/sandbox/shell-sandbox-runner.js';
/** The real stdio of this process, wired as a newline-delimited JSON-RPC channel. */
export function createStdioAcpIo() {
    return {
        stdin: Readable.toWeb(process.stdin),
        stdout: Writable.toWeb(process.stdout),
        writeStderr: (message) => {
            process.stderr.write(`${message}\n`);
        },
        // An empty write resolves once every earlier write to the same handle has
        // completed, so this is the flush barrier `process.exit` needs to avoid
        // truncating a piped stdout.
        flushStdout: () => new Promise((resolve) => {
            process.stdout.write('', () => resolve());
        }),
    };
}
/** Returns the process exit code: 0 for a clean shutdown, 1 for a startup failure. */
export async function runAcp(argv, io) {
    const parsed = parseAcpArgs(argv);
    if (!parsed.ok) {
        io.writeStderr(`term2 acp: ${parsed.error}`);
        return 1;
    }
    const args = parsed.args;
    const { createLogger, createSessionContext } = createServeSessionLogWiring();
    const sessionContext = createSessionContext();
    const logger = createLogger('acp-launcher', sessionContext);
    const cliOverrides = {};
    if (args.effort) {
        cliOverrides.agent = {
            ...(args.effort ? { reasoningEffort: args.effort } : {}),
        };
    }
    // The launcher process is the credential owner: this is the operator's real
    // settings service (same env precedence as the CLI), not a per-session
    // overlay. Sessions receive only the factory's allowlisted snapshot.
    const settingsAuthority = new SettingsService({
        env: buildEnvOverrides(),
        ...(cliOverrides.agent ? { cli: cliOverrides } : {}),
        loggingService: logger,
    });
    // Validated after settings load so runtime-defined providers from
    // settings.json are registered before the flag is checked.
    if (args.provider && !getProviderIds().includes(args.provider)) {
        io.writeStderr(`term2 acp: unknown provider "${args.provider}".`);
        io.writeStderr('Available providers:');
        for (const provider of getAllProviders()) {
            io.writeStderr(`  - ${provider.id}  (${provider.label})`);
        }
        return 1;
    }
    if (args.provider && !args.model) {
        io.writeStderr('term2 acp: --provider requires --model; provider-only selection is not supported.');
        return 1;
    }
    if (args.model) {
        // The default prompter reads from the terminal. Here stdin carries the
        // JSON-RPC channel, so an ambiguous pattern must fail instead of consuming
        // protocol bytes: a null answer makes resolution report `cancelled`.
        const resolution = await resolveModelFlag({
            modelFlag: args.model,
            ...(args.provider ? { providerFlag: args.provider } : {}),
            settingsService: settingsAuthority,
            loggingService: logger,
            prompter: async () => null,
        });
        if (resolution.status === 'no_match') {
            io.writeStderr(`term2 acp: ${resolution.error}`);
            return 1;
        }
        if (resolution.status === 'cancelled') {
            io.writeStderr(`term2 acp: cannot resolve --model "${args.model}" non-interactively; pass an exact model id or <provider>/<model>.`);
            return 1;
        }
        if ('warnings' in resolution && resolution.warnings) {
            for (const warning of resolution.warnings)
                io.writeStderr(warning);
        }
        // A per-session override like every other CLI flag; it must not rewrite the
        // user's persisted defaults, so nothing here persists.
        settingsAuthority.set('agent.modelSelection', { model: resolution.modelId, provider: resolution.provider }, { persist: false });
        if (resolution.reasoningEffort && !args.effort) {
            settingsAuthority.set('agent.reasoningEffort', resolution.reasoningEffort, { persist: false });
        }
    }
    const sandboxWarning = await sandboxWarningFor();
    if (sandboxWarning)
        io.writeStderr(sandboxWarning);
    // Per-session scratch for the worker boundary. A unique directory (never
    // /tmp itself) so a session's TMPDIR cannot be shared with another process.
    let tempRoot;
    try {
        tempRoot = mkdtempSync(path.join(tmpdir(), 'term2-acp-'));
    }
    catch (error) {
        io.writeStderr(`term2 acp: cannot create the runtime scratch directory: ${messageOf(error)}`);
        return 1;
    }
    let runtimeFactory;
    let backend;
    let agent;
    try {
        runtimeFactory = createProductionRuntimeFactory({
            settingsAuthority,
            tmpDir: tempRoot,
            sandboxAvailable: true,
            allowWrite: true,
            createLogger,
            createSessionContext,
        });
        backend = createAcpV2SessionBackend({ runtimeFactory, logger });
        agent = createAcpV2Agent({ backend, logger, version: installationVersion });
    }
    catch (error) {
        rmSync(tempRoot, { recursive: true, force: true });
        io.writeStderr(`term2 acp: failed to start: ${messageOf(error)}`);
        return 1;
    }
    // The CLI module registers global SIGINT/SIGTERM handlers that force-exit for
    // interactive sessions. An ACP shutdown is bounded and must be allowed to
    // flush live conversations, so those listeners are parked for the run and put
    // back in the `finally`. Restoring them matters because this launcher owns
    // only its own two handlers: the parked ones belong to the CLI entrypoint, a
    // test host, or an instrumenting module, and dropping them would change how
    // the rest of the process reacts to a signal. The raw wrappers are parked so
    // a `once` listener keeps its one-shot semantics when it comes back.
    const parkedSigint = process.rawListeners('SIGINT');
    const parkedSigterm = process.rawListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    let requestShutdown = () => undefined;
    const shutdownRequested = new Promise((resolve) => {
        requestShutdown = resolve;
    });
    const onSignal = () => requestShutdown();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        const connection = agent.connect(acp.ndJsonStream(io.stdout, io.stdin));
        // EOF on stdin closes the connection (the SDK's receive loop ends with the
        // stream), so both a well-behaved client and a crashed one land here.
        await Promise.race([connection.closed, shutdownRequested]);
        await shutdownAcp({ backend, runtimeFactory, logger, io });
        try {
            await io.flushStdout?.();
        }
        catch {
            // The process is exiting; a failed final drain has no recovery path.
        }
        return 0;
    }
    finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        for (const listener of parkedSigint)
            process.on('SIGINT', listener);
        for (const listener of parkedSigterm)
            process.on('SIGTERM', listener);
        rmSync(tempRoot, { recursive: true, force: true });
    }
}
/**
 * Bounded teardown: cancel turns and close live sessions, logging (and warning
 * on stderr) rather than failing, because the client is already gone and there
 * is nothing left to report an error to. The deadline spans two grace periods:
 * each session's own dispose already spends one bounded grace period on
 * cancellation and another on shutdown, and a hang there must not hold the
 * process open forever.
 */
async function shutdownAcp(input) {
    const graceMs = Math.max(1, input.runtimeFactory.policy.shutdownGraceMs) * 2;
    let deadlineReached = false;
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
        deadlineTimer = setTimeout(() => {
            deadlineReached = true;
            resolve();
        }, graceMs);
    });
    try {
        await Promise.race([input.backend.shutdown(), deadline]);
    }
    catch (error) {
        input.logger.error('ACP shutdown failed', {
            eventType: 'acp.shutdown.failed',
            errorMessage: messageOf(error),
        });
        input.io.writeStderr(`term2 acp: shutdown failed: ${messageOf(error)}`);
    }
    finally {
        if (deadlineTimer)
            clearTimeout(deadlineTimer);
    }
    if (deadlineReached) {
        input.logger.warn('ACP shutdown deadline reached', { eventType: 'acp.shutdown.deadline', graceMs });
        input.io.writeStderr(`term2 acp: shutdown deadline reached after ${graceMs}ms; exiting anyway`);
    }
}
/**
 * Advisory only: the shell tool probes the runner per command and refuses the
 * unsandboxed fallback, so an unavailable sandbox never gates startup — it just
 * tells the operator up front why every shell call will be refused.
 */
async function sandboxWarningFor() {
    const describe = (availability) => `term2 acp: warning: shell sandbox unavailable: ${availability.type}${availability.reason ? ` (${availability.reason})` : ''}; shell tool calls will be refused`;
    try {
        const availability = await getDefaultShellSandboxRunner().availability();
        return availability.type === 'available' ? undefined : describe(availability);
    }
    catch (error) {
        return describe({ type: 'probe_failed', reason: messageOf(error) });
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=serve.js.map