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

function createTool(
    settingsService = createMockSettingsService(),
    editHealing?: typeof import('./edit-healing.js').healSearchReplaceParams,
) {
    return createSearchReplaceToolDefinition({
        loggingService: mockLoggingService,
        settingsService,
        ...(editHealing ? {editHealing} : {}),
    });
}

test.serial(
    'needsApproval auto-approves creation when search_content is empty and file is missing in edit mode',
    async t => {
        await withTempDir(async () => {
            const tool = createTool(
                createMockSettingsService({app: {editMode: true}}),
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
                createMockSettingsService({app: {editMode: true}}),
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
                createMockSettingsService({app: {editMode: true}}),
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
            const tool = createTool(
                createMockSettingsService({'tools.enableEditHealing': false}),
            );
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

test.serial(
    'execute heals search content when no match is found',
    async t => {
        await withTempDir(async dir => {
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'const foo = 1;\n');

            const tool = createTool(
                createMockSettingsService({'tools.enableEditHealing': true}),
                async params => ({
                    params: {
                        ...params,
                        search_content: 'const foo = 1;\n',
                    },
                    wasModified: true,
                    confidence: 0.9,
                }),
            );

            const result = await tool.execute({
                path: filePath,
                search_content: 'const foo = 2;\n',
                replace_content: 'const foo = 3;\n',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);
            t.true(parsed.output[0].message.includes('healed match'));

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'const foo = 3;\n');
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

test.serial(
    'execute performs normalized whitespace match across line breaks',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'normalized.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(
                absPath,
                'const foo = 1;\nconst bar = 2;\nconst baz = 3;\n',
            );

            const result = await tool.execute({
                path: filePath,
                search_content: 'const foo = 1; const bar = 2;',
                replace_content: 'const foo = 1;\nconst bar = 42;',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'const foo = 1;\nconst bar = 42;\nconst baz = 3;\n');
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

// ============================================================================
// EOL Normalization Tests
// ============================================================================

test.serial(
    'execute normalizes CRLF search content to match LF file',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'lf-file.txt';
            const absPath = path.join(dir, filePath);
            // File has LF line endings
            await fs.writeFile(absPath, 'line one\nline two\nline three');

            // Search content has CRLF line endings
            const result = await tool.execute({
                path: filePath,
                search_content: 'line one\r\nline two',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'replaced\nline three');
        });
    },
);

test.serial(
    'execute normalizes LF search content to match CRLF file',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'crlf-file.txt';
            const absPath = path.join(dir, filePath);
            // File has CRLF line endings
            await fs.writeFile(absPath, 'line one\r\nline two\r\nline three');

            // Search content has LF line endings
            const result = await tool.execute({
                path: filePath,
                search_content: 'line one\nline two',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            // Result should preserve the file's CRLF style
            t.is(updated, 'replaced\r\nline three');
        });
    },
);

test.serial(
    'execute preserves CRLF in replacement content when file uses CRLF',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'crlf-file.txt';
            const absPath = path.join(dir, filePath);
            // File has CRLF line endings
            await fs.writeFile(absPath, 'hello\r\nworld');

            const result = await tool.execute({
                path: filePath,
                search_content: 'hello',
                replace_content: 'new\nline',  // LF in replacement
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            // Replacement should use file's CRLF style
            t.is(updated, 'new\r\nline\r\nworld');
        });
    },
);

// ============================================================================
// Leading Filepath Comment Stripping Tests
// ============================================================================

test.serial(
    'execute strips leading filepath comment from search content',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'sample.ts';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'const x = 1;\nconst y = 2;');

            // Search content has a leading filepath comment (common model behavior)
            const result = await tool.execute({
                path: filePath,
                search_content: '// sample.ts\nconst x = 1;',
                replace_content: 'const x = 42;',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'const x = 42;\nconst y = 2;');
        });
    },
);

test.serial(
    'execute strips leading hash filepath comment from search content',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'script.py';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'x = 1\ny = 2');

            const result = await tool.execute({
                path: filePath,
                search_content: '# script.py\nx = 1',
                replace_content: 'x = 42',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'x = 42\ny = 2');
        });
    },
);

test.serial(
    'execute does not strip non-filepath leading comments',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'code.ts';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, '// TODO: fix this\nconst x = 1;');

            // This comment is not a filepath, so it should NOT be stripped
            const result = await tool.execute({
                path: filePath,
                search_content: '// TODO: fix this\nconst x = 1;',
                replace_content: 'const x = 42;',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.output[0].success);

            const updated = await fs.readFile(absPath, 'utf8');
            t.is(updated, 'const x = 42;');
        });
    },
);

// ============================================================================
// Summarization Marker Detection Tests
// ============================================================================

test.serial(
    'execute rejects search content with "Lines X-Y omitted" marker',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'line 1\nline 2\nline 3');

            const result = await tool.execute({
                path: filePath,
                search_content: 'line 1\nLines 2-50 omitted\nline 3',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);
            t.true(parsed.output[0].error.includes('omitted'));
        });
    },
);

test.serial(
    'execute rejects search content with ellipsis marker {…}',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'function foo() { /* code */ }');

            const result = await tool.execute({
                path: filePath,
                search_content: 'function foo() {…}',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);
            t.true(parsed.output[0].error.includes('ellipsis'));
        });
    },
);

test.serial(
    'execute rejects search content with /*...*/ marker',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'function foo() { return 1; }');

            const result = await tool.execute({
                path: filePath,
                search_content: 'function foo() { /*...*/ }',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);
            t.true(parsed.output[0].error.includes('/*...*/'));
        });
    },
);

test.serial(
    'execute rejects search content with // ... marker',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'content.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'const a = 1;\nconst b = 2;\nconst c = 3;');

            const result = await tool.execute({
                path: filePath,
                search_content: 'const a = 1;\n// ...\nconst c = 3;',
                replace_content: 'replaced',
                replace_all: false,
            });

            const parsed = JSON.parse(result);
            t.false(parsed.output[0].success);
            t.true(parsed.output[0].error.includes('// ...'));
        });
    },
);
