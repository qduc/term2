import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createReadFileToolDefinition } from './read-file.js';

const readFileToolDefinition = createReadFileToolDefinition();

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
    const originalCwd = process.cwd;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-'));

    // Mock process.cwd
    process.cwd = () => tempDir;

    try {
        await run(tempDir);
    } finally {
        process.cwd = originalCwd;
        await fs.rm(tempDir, {recursive: true, force: true});
    }
}

test.serial('needsApproval: returns false for read-only operation', async t => {
    await withTempDir(async () => {
        const result = await readFileToolDefinition.needsApproval({
            path: 'test.txt',
        });
        t.false(result);
    });
});

test.serial('execute: successfully reads a file', async t => {
    await withTempDir(async dir => {
        const filePath = 'test.txt';
        const content = 'Hello\nWorld\nFrom\nFile';
        await fs.writeFile(path.join(dir, filePath), content);

        const result = await readFileToolDefinition.execute({
            path: filePath,
        });

        // Result should include line numbers
        t.true(result.includes('1\tHello'));
        t.true(result.includes('2\tWorld'));
        t.true(result.includes('3\tFrom'));
        t.true(result.includes('4\tFile'));
    });
});

test.serial('execute: reads file with line range', async t => {
    await withTempDir(async dir => {
        const filePath = 'test.txt';
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        await fs.writeFile(path.join(dir, filePath), content);

        const result = await readFileToolDefinition.execute({
            path: filePath,
            start_line: 2,
            end_line: 4,
        });

        // Should only include lines 2-4
        t.false(result.includes('1\tLine 1'));
        t.true(result.includes('2\tLine 2'));
        t.true(result.includes('3\tLine 3'));
        t.true(result.includes('4\tLine 4'));
        t.false(result.includes('5\tLine 5'));
    });
});

test.serial('execute: reads file from start_line to end', async t => {
    await withTempDir(async dir => {
        const filePath = 'test.txt';
        const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
        await fs.writeFile(path.join(dir, filePath), content);

        const result = await readFileToolDefinition.execute({
            path: filePath,
            start_line: 3,
        });

        // Should include lines 3-5
        t.false(result.includes('1\tLine 1'));
        t.false(result.includes('2\tLine 2'));
        t.true(result.includes('3\tLine 3'));
        t.true(result.includes('4\tLine 4'));
        t.true(result.includes('5\tLine 5'));
    });
});

test.serial('execute: rejects path outside workspace', async t => {
    await withTempDir(async () => {
        const result = await readFileToolDefinition.execute({
            path: '../outside.txt',
        });

        t.true(result.includes('Error'));
        t.true(result.includes('outside workspace'));
    });
});

test.serial('execute: handles file not found', async t => {
    await withTempDir(async () => {
        const result = await readFileToolDefinition.execute({
            path: 'nonexistent.txt',
        });

        t.true(result.includes('Error'));
        t.true(result.includes('ENOENT') || result.includes('not found'));
    });
});

test.serial('execute: handles empty file', async t => {
    await withTempDir(async dir => {
        const filePath = 'empty.txt';
        await fs.writeFile(path.join(dir, filePath), '');

        const result = await readFileToolDefinition.execute({
            path: filePath,
        });

        t.is(result.trim(), '');
    });
});

test.serial('execute: handles line range beyond file length', async t => {
    await withTempDir(async dir => {
        const filePath = 'short.txt';
        const content = 'Line 1\nLine 2';
        await fs.writeFile(path.join(dir, filePath), content);

        const result = await readFileToolDefinition.execute({
            path: filePath,
            start_line: 1,
            end_line: 10,
        });

        // Should only include available lines
        t.true(result.includes('1\tLine 1'));
        t.true(result.includes('2\tLine 2'));
    });
});
