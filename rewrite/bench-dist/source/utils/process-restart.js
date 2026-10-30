import fs from 'node:fs';
import path from 'node:path';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** Snapshot only supported resume context; never replay the original prompt or launch argv. */
export function createRestartPlan(context) {
    const args = [context.entry, '--resume', context.sessionId];
    if (context.model.model)
        args.push('--model', context.model.model);
    if (context.model.provider)
        args.push('--provider', context.model.provider);
    if (context.reasoning)
        args.push('--reasoning', context.reasoning);
    args.push('--profile', context.profile);
    if (context.ssh) {
        args.push('--ssh', context.ssh.target, '--ssh-port', String(context.ssh.port));
        if (context.ssh.directory)
            args.push('--remote-dir', context.ssh.directory);
    }
    if (context.control) {
        args.push(`--control-socket=${context.control.name}`);
        if (context.control.discordInput)
            args.push('--discord-input');
    }
    const policy = {
        SHELL_AUTO_APPROVE_MODE: context.approval,
        SANDBOX_ENABLED: String(context.sandbox),
    };
    const env = Object.fromEntries(Object.entries({ ...process.env, ...policy }).filter((entry) => entry[1] !== undefined));
    const manualCommand = [
        ...Object.entries(policy).map(([key, value]) => `${key}=${quote(value)}`),
        process.execPath,
        ...args,
    ]
        .map((value, index) => (index < 2 ? value : quote(value)))
        .join(' ');
    return { args, env, manualCommand };
}
/** Refuse unsupported runners before releasing any live resources. Native exec failure may abort. */
export function assertRestartSupported(entry) {
    if (process.platform === 'win32' || typeof process.execve !== 'function') {
        throw new Error('In-place restart requires POSIX Node with process.execve support.');
    }
    if (process.execArgv.length || process.env.NODE_OPTIONS?.trim()) {
        throw new Error('In-place restart does not support Node flags, loaders or NODE_OPTIONS.');
    }
    if (path.basename(entry) !== 'cli.js' ||
        path.basename(path.dirname(entry)) !== 'dist' ||
        !fs.statSync(entry).isFile()) {
        throw new Error('In-place restart requires the current built dist/cli.js entry.');
    }
}
//# sourceMappingURL=process-restart.js.map