import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createApplyPatchToolDefinition } from './apply-patch.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

function parsePlainResult(result: string): any {
  const lines = result.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { success: false, error: 'No output', output: [{ success: false, error: 'No output' }] };
  }
  const output = lines.map((line) => {
    if (line.startsWith('Error: ')) {
      return { success: false, error: line.slice(7) };
    }
    return { success: true, message: line };
  });
  return { ...output[0], output };
}

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

it.sequential('create_file: creates a new file with content', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'new-file.txt';
    const diff = '@@ -0,0 +1 @@\n+Hello World';

    const result = await tool.execute({
      type: 'create_file',
      path: filePath,
      diff,
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message!.startsWith('Created')).toBe(true);

    const content = await fs.readFile(path.join(dir, filePath), 'utf8');
    expect(content.trim()).toBe('Hello World');
  });
});

it.sequential('update_file: updates an existing file', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('Hello\nUniverse');
  });
});

it.sequential('update_file: preserves parallel patches to different regions of the same file', async () => {
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
      const parsed = parsePlainResult(result);
      expect(parsed.output[0].success).toBe(true);
    }

    const content = await fs.readFile(absPath, 'utf8');
    expect(content.split('\n')).toEqual(tokens.map((_, index) => `done_${index}`));
  });
});

it.sequential('execute: applies batched patch operations in order', async () => {
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

    const parsed = parsePlainResult(result);
    expect(parsed.output.every((item: { success: boolean }) => item.success)).toBe(true);
    const messages = parsed.output.map((item: { message?: string }) => item.message ?? '');
    expect(messages.some((message: string) => message.startsWith('Created'))).toBe(true);
    expect(messages.some((message: string) => message.startsWith('Updated'))).toBe(true);

    const content = await fs.readFile(path.join(dir, 'batch.txt'), 'utf8');
    expect(content).toBe('Hello\nUniverse\n');
  });
});

// it.sequential('delete_file: deletes a file', async t => {
//     await withTempDir(async (dir) => {
//         const filePath = 'to-delete.txt';
//         const absPath = path.join(dir, filePath);
//         await fs.writeFile(absPath, 'content');

//         const result = await applyPatchToolDefinition.execute({
//             type: 'delete_file',
//             path: filePath,
//             diff: '', // diff is ignored for delete
//         });

//         const parsed = parsePlainResult(result);
//         expect(parsed.output[0].success).toBe(true);

//         await await expect(fs.readFile(absPath)).rejects.toThrow();
//     });
// });

// it.sequential('needsApproval: requires approval for delete_file', async t => {
//     await withTempDir(async () => {
//         const result = await applyPatchToolDefinition.needsApproval({
//             type: 'delete_file',
//             path: 'any.txt',
//             diff: '',
//         });
//         expect(result).toBe(true);
//     });
// });

it.sequential('needsApproval: requires approval for outside workspace', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'create_file',
      path: '../outside.txt',
      diff: '@@ -0,0 +1 @@\n+content',
    });
    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: auto-approves for create/update inside cwd', async () => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());

    const result = await tool.needsApproval({
      type: 'create_file',
      path: 'inside.txt',
      diff: '@@ -0,0 +1 @@\n+content',
    });
    expect(result).toBe(false);
  });
});

it.sequential('needsApproval: auto-approves invalid diffs (will fail in execute)', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    // Invalid diffs now return false (auto-approve) to avoid breaking the stream
    const result = await tool.needsApproval({
      type: 'create_file',
      path: 'test.txt',
      diff: 'garbage',
    });
    expect(result).toBe(false);
  });
});

it.sequential('needsApproval: update_file missing target requires approval', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'update_file',
      path: 'missing.txt',
      diff: '@@ anything\n-old\n+new',
    });
    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: update_file malformed diff auto-approves when file exists', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'existing.txt'), 'line 1\nline 2');
    const tool = createTool();
    const result = await tool.needsApproval({
      type: 'update_file',
      path: 'existing.txt',
      diff: 'garbage',
    });
    expect(result).toBe(false);
  });
});

it.sequential('execute: rejects invalid diffs with proper error', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      type: 'create_file',
      path: 'test.txt',
      diff: 'garbage',
    });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('Invalid patch')).toBe(true);
  });
});

it.sequential('execute: detailed error for unified diff headers', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      type: 'create_file',
      path: 'test.txt',
      diff: '--- a/test.txt\n+++ b/test.txt\n+Hello',
    });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('Remove standard file headers')).toBe(true);
  });
});

it.sequential('execute: detailed error for chunk headers with line numbers', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'Hello\nWorld');

    const result = await tool.execute({
      type: 'update_file',
      path: filePath,
      diff: '@@ -1,2 +1,2 @@\n Hello\n-World\n+Universe\n line missing',
    });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('Remove line numbers from "@@" headers')).toBe(true);
  });
});

it.sequential('execute: detailed error for leading line numbers', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      type: 'create_file',
      path: 'test.txt',
      diff: '10: +Hello',
    });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('Remove leading line numbers')).toBe(true);
  });
});

it.sequential('execute: detailed error for invalid line prefix', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      type: 'create_file',
      path: 'test.txt',
      diff: 'Hello',
    });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('Use only space, +, -, or @@ prefixes')).toBe(true);
  });
});

it.sequential('execute: detailed error for context block mismatch', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'line one\n  line two\nline three');

    // Missing line mismatch
    const result1 = await tool.execute({
      type: 'update_file',
      path: filePath,
      diff: '@@\n line one\n line missing\n line three',
    });
    const parsed1 = parsePlainResult(result1);
    expect(parsed1.output[0].success).toBe(false);
    expect(parsed1.output[0].error.includes('context block was not found')).toBe(true);

    // Indentation mismatch (with a missing line to force application failure)
    const result2 = await tool.execute({
      type: 'update_file',
      path: filePath,
      diff: '@@\n line one\n line two\n line missing\n line three', // diff has 0 spaces for 'line two', file has 2 spaces
    });
    const parsed2 = parsePlainResult(result2);
    expect(parsed2.output[0].success).toBe(false);
    expect(parsed2.output[0].error.includes('Mismatch details')).toBe(true);
  });
});
