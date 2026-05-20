import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createApplyPatchToolDefinition } from './apply-patch.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import type { ILoggingService } from '../services/service-interfaces.js';

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
    await fs.rm(tempDir, { recursive: true, force: true });
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
  return createApplyPatchToolDefinition({
    loggingService: mockLoggingService,
    settingsService,
  });
}

test.serial('create_file: creates a new file with content', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'new-file.txt';
    const diff = '@@ -0,0 +1 @@\n+Hello World';

    const result = await tool.execute({
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

test.serial('update_file: updates an existing file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'Hello\nWorld');

    const diff = '@@ -1,2 +1,2 @@\n Hello\n-World\n+Universe';

    const result = await tool.execute({
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

test.serial('update_file: preserves parallel patches to different regions of the same file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'parallel-patch.txt';
    const absPath = path.join(dir, filePath);
    const tokens = Array.from({ length: 12 }, (_, index) => `token_${index}`);
    await fs.writeFile(absPath, tokens.join('\n'));

    const results = await Promise.all(
      tokens.map((token, index) =>
        tool.execute({
          type: 'update_file',
          path: filePath,
          diff: `@@\n-${token}\n+done_${index}`,
        }),
      ),
    );

    for (const result of results) {
      const parsed = JSON.parse(result);
      t.true(parsed.output[0].success);
    }

    const content = await fs.readFile(absPath, 'utf8');
    t.deepEqual(
      content.split('\n'),
      tokens.map((_, index) => `done_${index}`),
    );
  });
});

test.serial('execute: applies batched patch operations in order', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();

    const result = await tool.execute({
      operations: [
        {
          type: 'create_file',
          path: 'batch.txt',
          diff: '@@ -0,0 +1,2 @@\n+Hello\n+World',
        },
        {
          type: 'update_file',
          path: 'batch.txt',
          diff: '@@\n Hello\n-World\n+Universe',
        },
      ],
    });

    const parsed = JSON.parse(result);
    t.true(parsed.output.every((item: { success: boolean }) => item.success));
    t.deepEqual(
      parsed.output.map((item: { operation: string }) => item.operation),
      ['create_file', 'update_file'],
    );

    const content = await fs.readFile(path.join(dir, 'batch.txt'), 'utf8');
    t.is(content, 'Hello\nUniverse\n');
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

test.serial('needsApproval: requires approval for outside workspace', async (t) => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'create_file',
      path: '../outside.txt',
      diff: '@@ -0,0 +1 @@\n+content',
    });
    t.true(result);
  });
});

test.serial('needsApproval: auto-approves for create/update inside cwd', async (t) => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());

    const result = await tool.needsApproval({
      type: 'create_file',
      path: 'inside.txt',
      diff: '@@ -0,0 +1 @@\n+content',
    });
    t.false(result);
  });
});

test.serial('needsApproval: auto-approves invalid diffs (will fail in execute)', async (t) => {
  await withTempDir(async () => {
    const tool = createTool();
    // Invalid diffs now return false (auto-approve) to avoid breaking the stream
    const result = await tool.needsApproval({
      type: 'create_file',
      path: 'test.txt',
      diff: 'garbage',
    });
    t.false(result);
  });
});

test.serial('needsApproval: update_file missing target requires approval', async (t) => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'update_file',
      path: 'missing.txt',
      diff: '@@ anything\n-old\n+new',
    });
    t.true(result);
  });
});

test.serial('needsApproval: update_file malformed diff auto-approves when file exists', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'existing.txt'), 'line 1\nline 2');
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'update_file',
      path: 'existing.txt',
      diff: 'garbage',
    });
    t.false(result);
  });
});

test.serial('execute: rejects invalid diffs with proper error', async (t) => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      type: 'create_file',
      path: 'test.txt',
      diff: 'garbage',
    });
    const parsed = JSON.parse(result);
    t.false(parsed.output[0].success);
    t.true(parsed.output[0].error.includes('Invalid patch'));
  });
});
