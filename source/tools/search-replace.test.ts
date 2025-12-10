import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {searchReplaceToolDefinition} from './search-replace.js';
import {settingsService} from '../services/settings-service.js';
import {loggingService} from '../services/logging-service.js';

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
    const originalCwd = process.cwd;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-search-replace-'));

    // Mock process.cwd
    process.cwd = () => tempDir;

    try {
        await run(tempDir);
    } finally {
        process.cwd = originalCwd;
        await fs.rm(tempDir, {recursive: true, force: true});
    }
}

// Mock settings and logging
const originalGet = settingsService.get;
const originalInfo = loggingService.info;
const originalWarn = loggingService.warn;
const originalError = loggingService.error;

test.beforeEach(() => {
    settingsService.get = originalGet;
    loggingService.info = () => {};
    loggingService.warn = () => {};
    loggingService.error = () => {};
});

test.afterEach(() => {
    settingsService.get = originalGet;
    loggingService.info = originalInfo;
    loggingService.warn = originalWarn;
    loggingService.error = originalError;
});

test.serial('needsApproval auto-approves a unique exact match in edit mode', async t => {
    await withTempDir(async dir => {
        const filePath = 'sample.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'hello world');

        settingsService.get = ((key: string) => {
            if (key === 'app.mode') return 'edit';
            return originalGet.call(settingsService, key);
        }) as any;

        const result = await searchReplaceToolDefinition.needsApproval({
            path: filePath,
            search_content: 'hello',
            replace_content: 'hi',
            replace_all: false,
        });

        t.false(result);
    });
});

test.serial('needsApproval requires approval when multiple exact matches and replace_all is false', async t => {
    await withTempDir(async dir => {
        const filePath = 'sample.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'hello world hello');

        settingsService.get = ((key: string) => {
            if (key === 'app.mode') return 'edit';
            return originalGet.call(settingsService, key);
        }) as any;

        const result = await searchReplaceToolDefinition.needsApproval({
            path: filePath,
            search_content: 'hello',
            replace_content: 'hi',
            replace_all: false,
        });

        t.true(result);
    });
});

test.serial('execute replaces only the first exact match when replace_all is false', async t => {
    await withTempDir(async dir => {
        const filePath = 'content.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'target before target after');

        const result = await searchReplaceToolDefinition.execute({
            path: filePath,
            search_content: 'target',
            replace_content: 'done',
            replace_all: false,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);

        const updated = await fs.readFile(absPath, 'utf8');
        t.is(updated, 'done before target after');
    });
});

test.serial('execute replaces all exact matches when replace_all is true', async t => {
    await withTempDir(async dir => {
        const filePath = 'content.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'foo foo foo');

        const result = await searchReplaceToolDefinition.execute({
            path: filePath,
            search_content: 'foo',
            replace_content: 'bar',
            replace_all: true,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);

        const updated = await fs.readFile(absPath, 'utf8');
        t.is(updated, 'bar bar bar');
    });
});

test.serial('execute performs relaxed match replacement when exact match is not found', async t => {
    await withTempDir(async dir => {
        const filePath = 'content.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, '    line one\n\tline two\nremainder');

        const result = await searchReplaceToolDefinition.execute({
            path: filePath,
            search_content: 'line one\nline two',
            replace_content: 'new block\n',
            replace_all: false,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);

        const updated = await fs.readFile(absPath, 'utf8');
        t.is(updated, 'new block\nremainder');
    });
});

test.serial('execute rejects multiple relaxed matches when replace_all is false', async t => {
    await withTempDir(async dir => {
        const filePath = 'content.txt';
        const absPath = path.join(dir, filePath);
        await fs.writeFile(absPath, 'foo\nbar\n---\nfoo\nbar\n');

        const result = await searchReplaceToolDefinition.execute({
            path: filePath,
            search_content: 'foo\nbar',
            replace_content: 'replacement',
            replace_all: false,
        });

        const parsed = JSON.parse(result);
        t.false(parsed.output[0].success);
        t.true(parsed.output[0].error.includes('relaxed matches'));

        const unchanged = await fs.readFile(absPath, 'utf8');
        t.is(unchanged, 'foo\nbar\n---\nfoo\nbar\n');
    });
});
