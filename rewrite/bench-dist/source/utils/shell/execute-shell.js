import { spawn } from 'child_process';
import process from 'process';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';
import { registerSandboxNetworkApprovalPauseController } from './sandbox/sandbox-network-approval.js';
import { killAllShellChildrenAtProcessExit, ShellChildRegistry } from './shell-child-registry.js';
/**
 * Process completion, output completion, and descendant cleanup are three
 * separate concerns, and none of them may wait indefinitely on another.
 *
 * The child's `'close'` event conflates the first two: Node emits it only once
 * the process has exited *and* every write end of its stdio pipes is closed.
 * Descendants inherit those pipes, so one surviving background process keeps
 * `'close'` from ever firing and the command hangs long after it finished.
 * `'exit'` reports only the direct child terminating, which is what "the
 * command is done" actually means, so that is what drives completion here.
 *
 * Output is then drained on a bounded deadline rather than to EOF. Once the
 * direct child has exited it cannot write anything more, so the grace period
 * only needs to cover bytes already sitting in kernel and Node buffers;
 * anything arriving later comes from an inherited writer we are not waiting
 * for. The bound is a policy, not a correctness guarantee — no finite grace
 * period can promise complete output while surviving descendants may still
 * write — so a truncated read is reported through `outputComplete` instead of
 * being silently indistinguishable from a clean one.
 */
const DEFAULT_DRAIN_GRACE_MS = 200;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
// Sandbox network approvals identify the active command through one global
// pause controller. Keep the lease until process settlement, not merely command
// wrapping, so a concurrent sandboxed command cannot replace that controller.
let sandboxExecutionLeaseHeld = false;
const sandboxExecutionLeaseWaiters = [];
function withSandboxExecutionLease(operation) {
    const execute = () => {
        sandboxExecutionLeaseHeld = true;
        return operation().finally(() => {
            const next = sandboxExecutionLeaseWaiters.shift();
            if (next) {
                next();
            }
            else {
                sandboxExecutionLeaseHeld = false;
            }
        });
    };
    if (!sandboxExecutionLeaseHeld)
        return execute();
    return new Promise((resolve, reject) => {
        sandboxExecutionLeaseWaiters.push(() => {
            void execute().then(resolve, reject);
        });
    });
}
const defaultExecImpl = (command, options, callback) => {
    const child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        env: options.env,
        detached: options.detached,
    });
    let stdout = '';
    let stderr = '';
    let ex = null;
    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    let stdoutAtEof = !child.stdout;
    let stderrAtEof = !child.stderr;
    let drainTimer;
    let finished = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    const overflow = options.overflow ?? 'kill';
    const streamsAtEof = () => stdoutAtEof && stderrAtEof;
    const releaseStreams = () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
    };
    const finish = (outputComplete) => {
        if (finished)
            return;
        finished = true;
        if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = undefined;
        }
        const meta = { outputComplete };
        if (ex) {
            callback(ex, stdout, stderr, meta);
            return;
        }
        if (exitCode !== 0 || exitSignal) {
            const err = new Error(`Command failed: ${command}`);
            err.code = exitCode;
            err.signal = exitSignal;
            callback(err, stdout, stderr, meta);
            return;
        }
        callback(null, stdout, stderr, meta);
    };
    const beginBoundedDrain = () => {
        if (streamsAtEof()) {
            finish(true);
            return;
        }
        if (drainTimer)
            return;
        drainTimer = setTimeout(() => {
            drainTimer = undefined;
            releaseStreams();
            finish(false);
        }, drainGraceMs);
    };
    const markEof = (which) => {
        if (which === 'stdout')
            stdoutAtEof = true;
        else
            stderrAtEof = true;
        if (exited)
            beginBoundedDrain();
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
        options.onOutputChunk?.('stdout', chunk);
        stdout += chunk;
        if (stdout.length > maxBuffer) {
            if (overflow === 'truncate') {
                // Drop from the head of the retained text; the process keeps running.
                stdout = stdout.slice(stdout.length - maxBuffer);
            }
            else {
                ex ??= new Error('stdout maxBuffer length exceeded');
                stopChildProcess(child);
            }
        }
    });
    child.stdout?.on('end', () => markEof('stdout'));
    child.stdout?.on('close', () => markEof('stdout'));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
        options.onOutputChunk?.('stderr', chunk);
        stderr += chunk;
        if (stderr.length > maxBuffer) {
            if (overflow === 'truncate') {
                // Drop from the head of the retained text; the process keeps running.
                stderr = stderr.slice(stderr.length - maxBuffer);
            }
            else {
                ex ??= new Error('stderr maxBuffer length exceeded');
                stopChildProcess(child);
            }
        }
    });
    child.stderr?.on('end', () => markEof('stderr'));
    child.stderr?.on('close', () => markEof('stderr'));
    child.on('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        beginBoundedDrain();
    });
    child.on('error', (err) => {
        ex ??= err;
        // A failed spawn emits 'error' without ever emitting 'exit', so completion
        // has to come from here or the command would never settle.
        if (!exited) {
            releaseStreams();
            finish(streamsAtEof());
        }
    });
    options.registerFinalizer?.(() => {
        releaseStreams();
        finish(streamsAtEof());
    });
    return child;
};
export class GatewayShellEnvironmentError extends Error {
    constructor() {
        super('gateway shell execution requires an explicit sanitized environment');
        this.name = 'GatewayShellEnvironmentError';
    }
}
function signalChildProcess(child, signal) {
    if (process.platform === 'win32') {
        return;
    }
    if (child.pid) {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch {
            // Fall back to the direct child when it has no usable process group.
        }
    }
    child.kill(signal);
}
/** Synchronously SIGKILL every live child's process group. Safe in a `process.on('exit')` hook. */
export function killLiveShellChildren() {
    killAllShellChildrenAtProcessExit();
}
function stopChildProcess(child) {
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, 'SIGTERM');
            return;
        }
        catch {
            // Fall back to killing the direct child when it has no usable process group.
        }
    }
    child.kill('SIGTERM');
}
export async function executeShellCommand(command, options = {}) {
    if (options.gatewayMode && options.env === undefined)
        throw new GatewayShellEnvironmentError();
    if (options.pauseOnSandboxNetworkApproval && !options.sshService && !options.registerSandboxNetworkPauseController) {
        return await withSandboxExecutionLease(() => executeShellCommandUnleased(command, options));
    }
    return await executeShellCommandUnleased(command, options);
}
async function executeShellCommandUnleased(command, options = {}) {
    const { cwd = process.cwd(), timeout, maxBuffer, env, gatewayMode = false, signal, sshService, execImpl = defaultExecImpl, pauseOnSandboxNetworkApproval = false, registerSandboxNetworkPauseController = registerSandboxNetworkApprovalPauseController, drainGraceMs = DEFAULT_DRAIN_GRACE_MS, terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS, childRegistry = new ShellChildRegistry(), onOutputChunk, overflow = 'kill', } = options;
    if (sshService) {
        return sshService.executeCommand(command, { cwd, signal, timeoutMs: timeout });
    }
    const childEnv = {
        ...(gatewayMode ? env : env ?? process.env),
        TMPDIR: gatewayMode ? env.TMPDIR : env?.TMPDIR ?? SANDBOX_TEMP_DIR,
    };
    // Child commands may use herdr routing helpers, but must not claim ownership
    // of the interactive pane that launched term2.
    delete childEnv.HERDR_ENV;
    // Latched the moment the deadline fires. A command that is killed and then
    // happens to exit 0 is still a timeout, so this is never cleared.
    let timedOutLatched = false;
    let outputCompleteResult;
    // Typed reason the executor itself ended the command (deadline, caller
    // cancellation, retained-output overflow), plus paused-time accounting for
    // the network-approval pause. The reason is recorded when termination
    // begins; overflow is classified from the retained-buffer error in the catch
    // below because that kill happens inside the exec implementation.
    let terminationKind;
    let pausedTotalMs = 0;
    let pausedSinceMs;
    const endPauseAccounting = () => {
        if (pausedSinceMs === undefined)
            return;
        pausedTotalMs += Date.now() - pausedSinceMs;
        pausedSinceMs = undefined;
    };
    try {
        const result = await new Promise((resolve, reject) => {
            let unregisterPauseController;
            let timeoutId;
            let killTimer;
            let hardFinishTimer;
            let timeoutStartedAt;
            let remainingTimeoutMs = timeout ?? 0;
            let paused = false;
            let settled = false;
            let finalizeImpl;
            let spawnedChild;
            const clearCommandTimeout = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                timeoutStartedAt = undefined;
            };
            /**
             * Settling does not cancel a pending SIGKILL. The direct child can exit
             * from SIGTERM while a descendant that ignored it still holds the pipe;
             * the drain grace then settles this call before the escalation is due.
             * Cancelling here would orphan that descendant permanently, so the timer
             * is left running to serve out the rest of its grace and fire.
             */
            const clearTerminationTimers = () => {
                if (hardFinishTimer) {
                    clearTimeout(hardFinishTimer);
                    hardFinishTimer = undefined;
                }
            };
            /**
             * Killing is cleanup, not the mechanism that bounds the command. Group
             * signalling misses any descendant that started its own session, so the
             * only real guarantee is that this settles on a deadline regardless of
             * whether anything actually died.
             */
            const beginTermination = (kind) => {
                if (settled || hardFinishTimer)
                    return;
                // The first cause wins: once the deadline has fired, a later caller
                // cancellation must not relabel the termination.
                terminationKind ??= kind;
                if (paused) {
                    paused = false;
                    endPauseAccounting();
                    signalChildProcess(child, 'SIGCONT');
                }
                stopChildProcess(child);
                killTimer = setTimeout(() => {
                    killTimer = undefined;
                    signalChildProcess(child, 'SIGKILL');
                    if (spawnedChild)
                        childRegistry.delete(spawnedChild);
                }, terminationGraceMs);
                hardFinishTimer = setTimeout(() => {
                    hardFinishTimer = undefined;
                    // Settle with whatever the impl has buffered, then unconditionally.
                    finalizeImpl?.();
                    if (!settled) {
                        settled = true;
                        cleanupListeners();
                        outputCompleteResult = false;
                        resolve({ stdout: '', stderr: '' });
                    }
                }, terminationGraceMs + drainGraceMs);
            };
            const stopChild = () => beginTermination('cancelled');
            const cleanupListeners = () => {
                // The termination grace is owed to the direct child. Once it has exited,
                // anything still in its group ignored SIGTERM or never saw it, and there
                // is nothing left to wait for -- escalate now rather than betting on a
                // timer that a short-lived host process may never live to fire.
                if (killTimer && (child.exitCode != null || child.signalCode != null)) {
                    clearTimeout(killTimer);
                    killTimer = undefined;
                    signalChildProcess(child, 'SIGKILL');
                }
                // A child still inside its grace stays tracked so the exit hook can take
                // its group down if we exit before the SIGKILL is due.
                if (spawnedChild && !killTimer)
                    childRegistry.delete(spawnedChild);
                clearCommandTimeout();
                clearTerminationTimers();
                signal?.removeEventListener('abort', stopChild);
                unregisterPauseController?.();
            };
            const startCommandTimeout = () => {
                if (remainingTimeoutMs <= 0 || timeoutId)
                    return;
                timeoutStartedAt = Date.now();
                timeoutId = setTimeout(() => {
                    timeoutId = undefined;
                    remainingTimeoutMs = 0;
                    timedOutLatched = true;
                    beginTermination('deadline');
                }, remainingTimeoutMs);
            };
            const pauseCommandTimeout = () => {
                if (!timeoutId || timeoutStartedAt === undefined)
                    return;
                remainingTimeoutMs = Math.max(0, remainingTimeoutMs - (Date.now() - timeoutStartedAt));
                clearCommandTimeout();
            };
            childRegistry.assertAvailable();
            const child = execImpl(command, {
                cwd,
                maxBuffer,
                env: childEnv,
                detached: process.platform !== 'win32',
                drainGraceMs,
                overflow,
                onOutputChunk,
                registerFinalizer: (finalize) => {
                    finalizeImpl = finalize;
                },
            }, (error, stdout, stderr, meta) => {
                if (settled)
                    return;
                settled = true;
                cleanupListeners();
                outputCompleteResult = meta?.outputComplete ?? true;
                if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
            if (!settled) {
                spawnedChild = child;
                childRegistry.add(child);
                startCommandTimeout();
                if (pauseOnSandboxNetworkApproval) {
                    unregisterPauseController = registerSandboxNetworkPauseController({
                        pause: () => {
                            if (settled || paused)
                                return;
                            pauseCommandTimeout();
                            paused = true;
                            pausedSinceMs = Date.now();
                            signalChildProcess(child, 'SIGSTOP');
                        },
                        resume: () => {
                            if (settled || !paused)
                                return;
                            paused = false;
                            endPauseAccounting();
                            startCommandTimeout();
                            signalChildProcess(child, 'SIGCONT');
                        },
                    });
                }
                if (signal?.aborted) {
                    stopChild();
                }
                else {
                    signal?.addEventListener('abort', stopChild, { once: true });
                }
                child.stdin?.end();
            }
        });
        return {
            stdout: result.stdout?.toString() ?? '',
            stderr: result.stderr?.toString() ?? '',
            exitCode: 0,
            timedOut: timedOutLatched,
            signal: null,
            outputComplete: outputCompleteResult ?? true,
            ...(terminationKind === undefined ? {} : { terminationKind }),
            ...(pausedTotalMs > 0 ? { pausedMs: pausedTotalMs } : {}),
        };
    }
    catch (error) {
        const exitCode = typeof error?.code === 'number' ? error.code : null;
        const signal = error?.signal ?? null;
        // The deadline latch is authoritative. A child can receive SIGTERM from
        // outside this executor (for example, a process-control command matching
        // its own supervision shell), and that must not be mistaken for expiry.
        // Preserve the legacy cancellation bit for callers that still consume it;
        // the typed reason is what distinguishes cancellation from a deadline.
        const timedOut = timedOutLatched || terminationKind === 'cancelled';
        // The retained-buffer overflow kill happens inside defaultExecImpl, so the
        // executor never began termination for it; classify it from the error the
        // implementation reports instead of leaving it as an unexplained signal.
        let classifiedKind = terminationKind;
        if (classifiedKind === undefined) {
            if (typeof error?.message === 'string' && error.message.includes('maxBuffer length exceeded')) {
                classifiedKind = 'output-overflow';
            }
            else if (error?.killed || signal !== null) {
                // This is a process termination observed by the executor, not an
                // executor-owned deadline. Keep it explicit so callers do not need to
                // infer timeout attribution from SIGTERM/SIGKILL.
                classifiedKind = 'process-terminated';
            }
        }
        return {
            stdout: error?.stdout?.toString() ?? '',
            stderr: error?.stderr?.toString() ?? '',
            exitCode,
            timedOut,
            signal,
            outputComplete: outputCompleteResult ?? true,
            ...(classifiedKind === undefined ? {} : { terminationKind: classifiedKind }),
            ...(pausedTotalMs > 0 ? { pausedMs: pausedTotalMs } : {}),
        };
    }
}
//# sourceMappingURL=execute-shell.js.map