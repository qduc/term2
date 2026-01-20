import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {createCreateFileToolDefinition} from './create-file.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';
import type {ILoggingService} from '../services/service-interfaces.js';

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
    const originalCwd = process.cwd;
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'term2-create-file-'),
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
    return createCreateFileToolDefinition({
        loggingService: mockLoggingService,
        settingsService,
    });
}

test.serial(
    'needsApproval auto-approves creation in edit mode when inside workspace',
    async t => {
        await withTempDir(async () => {
            const tool = createTool(
                createMockSettingsService({app: {editMode: true}}),
            );
            const filePath = 'new-file.txt';

            const result = await tool.needsApproval({
                path: filePath,
                content: 'initial content',
            });

            t.false(result);
        });
    },
);

test.serial(
    'needsApproval requires approval when not in edit mode',
    async t => {
        await withTempDir(async () => {
            const tool = createTool(
                createMockSettingsService({app: {editMode: false}}),
            );
            const filePath = 'new-file.txt';

            const result = await tool.needsApproval({
                path: filePath,
                content: 'initial content',
            });

            t.true(result);
        });
    },
);

test.serial(
    'execute creates a new file and returns success',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'test-file.txt';
            const absPath = path.join(dir, filePath);
            const content = 'hello world';

            const result = await tool.execute({
                path: filePath,
                content: content,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.success);
            t.is(parsed.path, filePath);

            const createdContent = await fs.readFile(absPath, 'utf8');
            t.is(createdContent, content);
        });
    },
);

test.serial(
    'execute fails if file already exists',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'existing.txt';
            const absPath = path.join(dir, filePath);
            await fs.writeFile(absPath, 'original');

            const result = await tool.execute({
                path: filePath,
                content: 'new content',
            });

            const parsed = JSON.parse(result);
            t.false(parsed.success);
            t.true(parsed.error.includes('already exists'));

            const content = await fs.readFile(absPath, 'utf8');
            t.is(content, 'original');
        });
    },
);

test.serial(
    'execute creates parent directories automatically',
    async t => {
        await withTempDir(async dir => {
            const tool = createTool();
            const filePath = 'subdir/deep/file.txt';
            const absPath = path.join(dir, filePath);
            const content = 'deep content';

            const result = await tool.execute({
                path: filePath,
                content: content,
            });

            const parsed = JSON.parse(result);
            t.true(parsed.success);

            const createdContent = await fs.readFile(absPath, 'utf8');
            t.is(createdContent, content);
        });
    },
);

test.serial(
    'formatCommandMessage returns correct base message structure',
    async t => {
        const tool = createTool();
        const callArgs = { path: 'new.txt', content: 'test' };

        const item = {
            rawItem: {
                arguments: JSON.stringify(callArgs),
            },
            output: JSON.stringify({
                success: true,
                path: 'new.txt',
                message: 'Created new.txt',
            }),
        };

        const messages = tool.formatCommandMessage(item, 0, new Map());

        t.is(messages.length, 1);
        t.is(messages[0].command, 'create_file "new.txt"');
        t.true(messages[0].success);
        t.is(messages[0].toolName, 'create_file');
        t.deepEqual(messages[0].toolArgs, callArgs);
    },
);
