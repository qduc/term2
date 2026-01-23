import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createFindFilesToolDefinition } from './find-files.js';

const findFilesToolDefinition = createFindFilesToolDefinition();
const findFilesToolDefinitionAllowOutside = createFindFilesToolDefinition({
	allowOutsideWorkspace: true,
});

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
	const originalCwd = process.cwd;
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-'));
	const workspaceDir = path.join(rootDir, 'workspace');
	await fs.mkdir(workspaceDir, {recursive: true});

	// Mock process.cwd (treat workspaceDir as the "workspace")
	process.cwd = () => workspaceDir;

	try {
		await run(workspaceDir);
	} finally {
		process.cwd = originalCwd;
		await fs.rm(rootDir, {recursive: true, force: true});
	}
}

test.serial('needsApproval: returns false for read-only operation', async t => {
	await withTempDir(async () => {
		const result = await findFilesToolDefinition.needsApproval({
			pattern: '*.ts',
			path: null,
			max_results: null,
		});
		t.false(result);
	});
});

test.serial('execute: finds files by exact name', async t => {
	await withTempDir(async dir => {
		// Create test files
		await fs.writeFile(path.join(dir, 'test.ts'), '');
		await fs.writeFile(path.join(dir, 'other.js'), '');

		const result = await findFilesToolDefinition.execute({
			pattern: 'test.ts',
			path: null,
			max_results: null,
		});

		t.true(result.includes('test.ts'));
		t.false(result.includes('other.js'));
	});
});

test.serial('execute: finds files by glob pattern', async t => {
	await withTempDir(async dir => {
		// Create test files
		await fs.writeFile(path.join(dir, 'file1.ts'), '');
		await fs.writeFile(path.join(dir, 'file2.ts'), '');
		await fs.writeFile(path.join(dir, 'file3.js'), '');

		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: null,
			max_results: null,
		});

		t.true(result.includes('file1.ts'));
		t.true(result.includes('file2.ts'));
		t.false(result.includes('file3.js'));
	});
});

test.serial(
	'execute: finds files in nested directories with glob pattern',
	async t => {
		await withTempDir(async dir => {
			// Create nested directory structure
			await fs.mkdir(path.join(dir, 'src'));
			await fs.mkdir(path.join(dir, 'src/utils'));
			await fs.writeFile(path.join(dir, 'src/index.ts'), '');
			await fs.writeFile(path.join(dir, 'src/utils/helper.ts'), '');
			await fs.writeFile(path.join(dir, 'readme.md'), '');

			const result = await findFilesToolDefinition.execute({
				pattern: '*.ts',
				path: null,
				max_results: null,
			});

			t.true(result.includes('src/index.ts') || result.includes('index.ts'));
			t.true(
				result.includes('src/utils/helper.ts') ||
					result.includes('utils/helper.ts'),
			);
			t.false(result.includes('readme.md'));
		});
	},
);

test.serial('execute: restricts search to specified path', async t => {
	await withTempDir(async dir => {
		// Create nested directory structure
		await fs.mkdir(path.join(dir, 'src'));
		await fs.mkdir(path.join(dir, 'tests'));
		await fs.writeFile(path.join(dir, 'src/app.ts'), '');
		await fs.writeFile(path.join(dir, 'tests/app.test.ts'), '');

		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: 'src',
			max_results: null,
		});

		t.true(result.includes('app.ts'));
		t.false(result.includes('app.test.ts'));
	});
});

test.serial('execute: respects max_results limit', async t => {
	await withTempDir(async dir => {
		// Create many files
		for (let i = 1; i <= 10; i++) {
			await fs.writeFile(path.join(dir, `file${i}.ts`), '');
		}

		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: null,
			max_results: 5,
		});

		const lines = result.trim().split('\n');
		// Should have 5 file results + empty line + 1 note line = 7 lines max
		t.true(lines.length <= 8);
		t.true(result.includes('Results limited to'));
	});
});

test.serial('execute: handles no matches found', async t => {
	await withTempDir(async dir => {
		await fs.writeFile(path.join(dir, 'file.js'), '');

		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: null,
			max_results: null,
		});

		t.true(result.includes('No files found'));
	});
});

test.serial('execute: rejects path outside workspace', async t => {
	await withTempDir(async () => {
		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: '../outside',
			max_results: null,
		});

		t.true(result.includes('Error'));
		t.true(result.includes('outside workspace'));
	});
});

test.serial('execute: in allowOutsideWorkspace mode, can search outside workspace', async t => {
	await withTempDir(async dir => {
		const outsideDir = path.join(dir, '..', 'outside');
		await fs.mkdir(outsideDir, {recursive: true});
		await fs.writeFile(path.join(outsideDir, 'outside.ts'), '');
		await fs.writeFile(path.join(outsideDir, 'outside.js'), '');

		const result = await findFilesToolDefinitionAllowOutside.execute({
			pattern: '*.ts',
			path: '../outside',
			max_results: null,
		});

		t.true(result.includes('outside.ts'));
		t.false(result.includes('outside.js'));
		t.false(result.includes('outside workspace'));
	});
});

test.serial('execute: handles non-existent directory', async t => {
	await withTempDir(async () => {
		const result = await findFilesToolDefinition.execute({
			pattern: '*.ts',
			path: 'nonexistent',
			max_results: null,
		});

		t.true(result.includes('Error') || result.includes('No files found'));
	});
});
