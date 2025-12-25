import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {createSearchReplaceToolDefinition} from './search-replace.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';
import type {ILoggingService} from '../services/service-interfaces.js';

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
    const originalCwd = process.cwd;
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'term2-search-replace-'),
    );

    // Mock process.cwd
    process.cwd = () => tempDir;

    try {
        await run(tempDir);
    } finally {
        process.cwd = originalCwd;
        await fs.rm(tempDir, {recursive: true, force: true});
    }
}

const mockLoggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
};

function createTool(settingsService = createMockSettingsService()) {
    return createSearchReplaceToolDefinition({
        loggingService: mockLoggingService,
        settingsService,
    });
}

test.serial(
    'needsApproval auto-approves creation when search_content is empty and file is missing in edit mode',
    async t => {
        await withTempDir(async () => {
            const tool = createTool(
                createMockSettingsService({app: {mode: 'edit'}}),
            );
            const filePath = 'new-file.txt';

            const result = await tool.needsApproval({
                path: filePath,
                search_content: '',
                replace_content: 'initial content',
                replace_all: false,
            });

            t.false(result);
        });
    },
);

test.serial(
    'needsApproval auto-approves a unique exact match in edit mode',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool(
                createMockSettingsService({app: {mode: 'edit'}}),
            );
            const filePath = 'sample.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'hello world');

            const result = await tool.needsApproval({
                path: filePath,
                search_content: 'hello',
                replace_content: 'hi',
                replace_all: false,
            });

            t.false(result);
        });
    },
);

test.serial(
    'needsApproval requires approval when multiple exact matches and replace_all is false',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool(
                createMockSettingsService({app: {mode: 'edit'}}),
            );
            const filePath = 'sample.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'hello world hello');

            const result = await tool.needsApproval({
                path: filePath,
                search_content: 'hello',
                replace_content: 'hi',
                replace_all: false,
            });

            t.true(result);
        });
    },
);

test.serial(
    'execute replaces only the first exact match when replace_all is false',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'target before target after');

            const result = await tool.execute({
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
    },
);

test.serial(
    'execute replaces all exact matches when replace_all is true',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'foo foo foo');

            const result = await tool.execute({
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
    },
);

test.serial(
    'execute performs relaxed match replacement when exact match is not found',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, '    line one\n\tline two\nremainder');

            const result = await tool.execute({
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
    },
);

test.serial(
    'execute replaces first of multiple exact matches when replace_all is false',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'foo\nbar\n---\nfoo\nbar\n');

            const result = await tool.execute({
                path: filePath,
                search_content: 'foo\nbar',
                replace_content: 'replacement',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'replacement\n---\nfoo\nbar\n');
        });
    },
);

test.serial(
    'execute rejects multiple relaxed matches when replace_all is false',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(
                absPath,
                '  foo  \n\tbar\n---\n  foo  \n\tbar\n',
            );

            const result = await tool.execute({
                path: filePath,
                search_content: 'foo\nbar',
                replace_content: 'replacement',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);
            t.true(parsed.output[0].error.includes('relaxed matches'));

            const unchanged = await fs.readFile(absPath, 'utf8');
            t.is(unchanged, '  foo  \n\tbar\n---\n  foo  \n\tbar\n');
        });
    },
);

test.serial(
    'execute creates a new file when search_content is empty and file is missing',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'missing.txt';
            const absPath = path.join(dir, filePath);

            const result = await tool.execute({
                path: filePath,
                search_content: '',
                replace_content: 'new content',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const createdContent = await fs.readFile(absPath, 'utf8');
            t.is(createdContent, 'new content');
        });
    },
);

test.serial(
    'execute reports failure when search string is not found',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            const originalContent = 'hello world';
            await fs.writeFile(absPath, originalContent);

            const result = await tool.execute({
                path: filePath,
                search_content: 'nonexistent',
                replace_content: 'replacement',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);

            const unchanged = await fs.readFile(absPath, 'utf8');
            t.is(unchanged, originalContent);
        });
    },
);

test.serial('execute treats special regex characters literally', async t => {
    await withTempDir(async dir => {
        const tool = createTool();
        const filePath = 'code.js';
        const absPath = path.join(dir, filePath);
        const originalContent = 'function test() { return [1, 2, 3]; }';
        await fs.writeFile(absPath, originalContent);

        const result = await tool.execute({
            path: filePath,
            search_content: '[1, 2, 3]',
            replace_content: '[4, 5, 6]',
            replace_all: false,
        });

        const parsed = JSON.parse(result);
        t.true(parsed.output[0].success);

        const updated = await fs.readFile(absPath, 'utf8');
        t.is(updated, 'function test() { return [4, 5, 6]; }');
    });
});

test.serial(
    'execute deletes content when replacement is empty string',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'sample.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'before DELETE_ME after');

            const result = await tool.execute({
                path: filePath,
                search_content: 'DELETE_ME ',
                replace_content: '',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'before after');
        });
    },
);

test.serial(
    'execute performs exact multi-line match without whitespace normalization',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'exact.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'line one\nline two\nline three');

            const result = await tool.execute({
                path: filePath,
                search_content: 'line one\nline two',
                replace_content: 'new content',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'new content\nline three');
        });
    },
);

test.serial(
    'execute handles leading/trailing whitespace differences in relaxed mode',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'whitespace.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, '  foo  \nbar');

            const result = await tool.execute({
                path: filePath,
                search_content: 'foo\nbar',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'replaced');
        });
    },
);

test.serial('execute does not match substrings in relaxed mode', async t => {
    await withTempDir(async dir => {
        const tool = createTool();
        const filePath = 'substring.txt';
        const absPath = path.join(dir, filePath);
        const originalContent = '  formatted text  ';
        await fs.writeFile(absPath, originalContent);

        // Search for "format" with different whitespace to trigger relaxed mode
        // Relaxed mode should NOT match because it compares entire trimmed lines,
        // and "format" (trimmed) !== "formatted text" (trimmed)
        const result = await tool.execute({
            path: filePath,
            search_content: '    format    ',
            replace_content: 'replacement',
            replace_all: false,
        });

        const parsed = JSON.parse(result);
        t.false(parsed.output[0].success);

        const unchanged = await fs.readFile(absPath, 'utf8');
        t.is(unchanged, originalContent);
    });
});
