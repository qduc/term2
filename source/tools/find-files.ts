import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import {resolveWorkspacePath} from './utils.js';
import type {ToolDefinition} from './types.js';

const execPromise = util.promisify(exec);

const findFilesParametersSchema = z.object({
	pattern: z
		.string()
		.describe(
			'Glob pattern or filename to search for (e.g., "*.ts", "**/*.test.ts", "README.md")',
		),
	path: z
		.string()
		.optional()
		.nullable()
		.describe(
			'Directory to search in. Use "." for current directory. Defaults to current directory.',
		),
	max_results: z
		.number()
		.int()
		.positive()
		.optional()
		.nullable()
		.describe('Maximum number of results to return. Defaults to 50.'),
});

export type FindFilesToolParams = z.infer<typeof findFilesParametersSchema>;

let hasFd: boolean | null = null;

async function checkFdAvailability(): Promise<boolean> {
	if (hasFd !== null) return hasFd;
	try {
		await execPromise('fd --version');
		hasFd = true;
	} catch {
		hasFd = false;
	}
	return hasFd;
}

export const findFilesToolDefinition: ToolDefinition<FindFilesToolParams> = {
	name: 'find_files',
	description:
		'Search for files by name in the workspace. Useful for finding files by pattern, exploring project structure, or locating specific files.',
	parameters: findFilesParametersSchema,
	needsApproval: () => false, // Search is read-only and safe
	execute: async params => {
		const {pattern, path: searchPath, max_results} = params;

		// Validate pattern is not empty
		if (!pattern || pattern.trim() === '') {
			return 'Error: Search pattern cannot be empty. Please provide a valid file name or glob pattern.';
		}

		const limit = max_results ?? 50;
		const targetPath = searchPath?.trim() || '.';

		try {
			// Validate path is within workspace
			const absolutePath = resolveWorkspacePath(targetPath);

			const useFd = await checkFdAvailability();
			let command = '';

			if (useFd) {
				// Use fd (faster and more user-friendly)
				const args = [
					'fd',
					'--color=never',
					'--type',
					'f', // files only
					'--glob', // use glob pattern matching
				];

				// Escape pattern for shell
				args.push(`'${pattern.replace(/'/g, "'\\''")}'`);
				args.push(`'${absolutePath.replace(/'/g, "'\\''")}'`);

				command = args.join(' ');
			} else {
				// Fallback to find
				const args = [
					'find',
					`'${absolutePath.replace(/'/g, "'\\''")}'`,
					'-type',
					'f',
					'-name',
				];

				// Escape pattern for shell
				args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

				command = args.join(' ');
			}

			const {stdout} = await execPromise(command, {
				maxBuffer: 10 * 1024 * 1024, // 10MB buffer
				cwd: process.cwd(), // Run command from current working directory
			});

			const trimmed = stdout.trim();

			if (!trimmed) {
				return `No files found matching pattern: ${pattern}`;
			}

			const lines = trimmed.split('\n');

			// Remove './' prefix from paths for cleaner output
			const cleanedLines = lines.map(line =>
				line.startsWith('./') ? line.substring(2) : line,
			);

			// Apply limit
			let result = cleanedLines.slice(0, limit).join('\n');

			// Add note if results were truncated
			if (cleanedLines.length > limit) {
				result += `\n\nNote: Results limited to ${limit} files. Found ${cleanedLines.length} total matches. Use max_results parameter to see more.`;
			}

			return result;
		} catch (error: any) {
			// Handle path resolution errors
			if (error.message?.includes('outside workspace')) {
				return `Error: ${error.message}`;
			}

			// fd/find returns exit code 1 if no matches found
			if (error.code === 1) {
				return `No files found matching pattern: ${pattern}`;
			}

			// Handle other errors
			return `Error: ${error.message || String(error)}`;
		}
	},
};
