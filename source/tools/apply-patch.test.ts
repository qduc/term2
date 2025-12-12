import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {applyPatchToolDefinition} from './apply-patch.js';
import {settingsService} from '../services/settings-service.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';
import {loggingService} from '../services/logging-service.js';

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

// Create a mock settings service instance for tests
const mockSettingsService = createMockSettingsService();

// Mock settings and logging
const originalGet = settingsService.get.bind(settingsService);
const originalInfo = loggingService.info;
const originalError = loggingService.error;
const originalSecurity = loggingService.security;

test.beforeEach(() => {
    // Mock settingsService.get to use the mock instance
    settingsService.get = mockSettingsService.get.bind(mockSettingsService);

    // Disable logging for tests
    loggingService.info = () => {};
    loggingService.error = () => {};
    loggingService.security = () => {};
});

test.afterEach(() => {
    // Restore original settings service and logging
    settingsService.get = originalGet;
    loggingService.info = originalInfo;
    loggingService.error = originalError;
    loggingService.security = originalSecurity;
});

test.serial('create_file: creates a new file with content', async t => {
    await withTempDir(async (dir) => {
        const filePath = 'new-file.txt';
        const diff = '@@ -0,0 +1 @@\n+Hello World';

        const result = await applyPatchToolDefinition.execute({
            type: 'create_file',
            path: filePath,
            diff,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);
        t.is(parsed.output[0].operation, 'create_file');

        const content = await fs.readFile(path.join(dir, filePath), 'utf8');
        t.is(content.trim(), 'Hello World');
    });
});

test.serial('update_file: updates an existing file', async t => {
    await withTempDir(async (dir) => {
        const filePath = 'existing.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'Hello\nWorld');

        const diff = '@@ -1,2 +1,2 @@\n Hello\n-World\n+Universe';

        const result = await applyPatchToolDefinition.execute({
            type: 'update_file',
            path: filePath,
            diff,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);

        const content = await fs.readFile(absPath, 'utf8');
        t.is(content, 'Hello\nUniverse');
    });
});

// test.serial('delete_file: deletes a file', async t => {
//     await withTempDir(async (dir) => {
//         const filePath = 'to-delete.txt';
//         const absPath = path.join(dir, filePath);
//         await fs.writeFile(absPath, 'content');

//         const result = await applyPatchToolDefinition.execute({
//             type: 'delete_file',
//             path: filePath,
//             diff: '', // diff is ignored for delete
//         });

//         const parsed = JSON.parse(result);
//         t.true(parsed.output[0].success);

//         await t.throwsAsync(fs.readFile(absPath));
//     });
// });

// test.serial('needsApproval: requires approval for delete_file', async t => {
//     await withTempDir(async () => {
//         const result = await applyPatchToolDefinition.needsApproval({
//             type: 'delete_file',
//             path: 'any.txt',
//             diff: '',
//         });
//         t.true(result);
//     });
// });

test.serial('needsApproval: requires approval for outside workspace', async t => {
    await withTempDir(async () => {
        const result = await applyPatchToolDefinition.needsApproval({
            type: 'create_file',
            path: '../outside.txt',
            diff: '@@ -0,0 +1 @@\n+content',
        });
        t.true(result);
    });
});

test.serial('needsApproval: auto-approves in edit mode for create/update inside cwd', async t => {
    await withTempDir(async () => {
        // Create a custom mock that returns 'edit' mode
        const editModeMock = createMockSettingsService({app: {mode: 'edit'}});
        settingsService.get = editModeMock.get.bind(editModeMock);

        const result = await applyPatchToolDefinition.needsApproval({
            type: 'create_file',
            path: 'inside.txt',
            diff: '@@ -0,0 +1 @@\n+content',
        });
        t.false(result);
    });
});

test.serial('needsApproval: requires approval in default mode', async t => {
    await withTempDir(async () => {
        // Create a custom mock that returns 'default' mode
        const defaultModeMock = createMockSettingsService({app: {mode: 'default'}});
        settingsService.get = defaultModeMock.get.bind(defaultModeMock);

        const result = await applyPatchToolDefinition.needsApproval({
            type: 'create_file',
            path: 'inside.txt',
            diff: '@@ -0,0 +1 @@\n+content',
        });
        t.true(result);
    });
});


test.serial('needsApproval: auto-approves invalid diffs (will fail in execute)', async t => {
    await withTempDir(async () => {
        // Invalid diffs now return false (auto-approve) to avoid breaking the stream
        const result = await applyPatchToolDefinition.needsApproval({
            type: 'create_file',
            path: 'test.txt',
            diff: 'garbage',
        });
        t.false(result);
    });
});

test.serial('execute: rejects invalid diffs with proper error', async t => {
    await withTempDir(async () => {
        const result = await applyPatchToolDefinition.execute({
            type: 'create_file',
            path: 'test.txt',
            diff: 'garbage',
        });
        const parsed = JSON.parse(result);
        t.false(parsed.output[0].success);
        t.true(parsed.output[0].error.includes('Invalid patch'));
    });
});
