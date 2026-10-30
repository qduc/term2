import process from 'node:process';
import { SHELL_CONTEXT_PREFIX } from '../../services/conversation/conversation-store.js';
import { executeShellCommand } from './execute-shell.js';
import { formatShellExecutionOutput } from './shell-output.js';
export function serializeShellHistory(entries) {
    if (entries.length === 0) {
        return '';
    }
    const blocks = entries.map((entry) => {
        const lines = [`$ ${entry.command}`];
        const output = entry.output.trim();
        if (output) {
            lines.push(output);
        }
        lines.push(`Exit: ${entry.timedOut ? 'timeout' : entry.exitCode != null ? entry.exitCode : 'null'}`);
        return lines.join('\n');
    });
    return [SHELL_CONTEXT_PREFIX, ...blocks].join('\n\n');
}
export async function executeFormattedShellCommand(params) {
    const timeoutValue = params.settingsService.get('shell.timeout');
    const timeout = timeoutValue != null ? timeoutValue : undefined;
    const maxOutputLengthValue = params.settingsService.get('shell.maxOutputChars');
    const maxOutputLength = maxOutputLengthValue != null ? maxOutputLengthValue : undefined;
    const startedAt = Date.now();
    const result = await executeShellCommand(params.command, {
        timeout,
        maxBuffer: 1024 * 1024,
        sshService: params.sshService,
        cwd: params.sshInfo?.remoteDir,
    });
    const formattedOutput = await formatShellExecutionOutput({
        command: params.command,
        cwd: params.sshInfo?.remoteDir ?? process.cwd(),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        maxOutputLength,
        durationMs: Date.now() - startedAt,
    });
    return {
        text: formattedOutput.text,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
    };
}
//# sourceMappingURL=shell-session.js.map