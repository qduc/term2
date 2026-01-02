import {exec} from 'child_process';
import util from 'util';
import process from 'process';

const execPromise = util.promisify(exec);

export interface ShellExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export interface ExecuteShellOptions {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
}

export async function executeShellCommand(
    command: string,
    options: ExecuteShellOptions = {},
): Promise<ShellExecutionResult> {
    const {cwd = process.cwd(), timeout, maxBuffer} = options;

    try {
        const result = await execPromise(command, {
            cwd,
            timeout,
            maxBuffer,
        });

        return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            exitCode: 0,
            timedOut: false,
        };
    } catch (error: any) {
        const exitCode = typeof error?.code === 'number' ? error.code : null;
        const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');

        return {
            stdout: error?.stdout ?? '',
            stderr: error?.stderr ?? '',
            exitCode,
            timedOut,
        };
    }
}
