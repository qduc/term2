import { it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createApplyPatchToolDefinition } from './apply-patch.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { SANDBOX_TEMP_DIR } from '../../utils/shell/temp-dir.js';
import { SessionAccessState } from '../../services/session/session-access-state.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

type PlainResultItem = {
  success: boolean;
  message: string;
  error: string;
};

type PlainResult = PlainResultItem & { output: PlainResultItem[] };

function parsePlainResult(result: unknown): PlainResult {
  if (typeof result !== 'string') {
    throw new Error(`Expected plain-text tool result, received ${typeof result}`);
  }
  const lines = result.split('\n').filter(Boolean);
  if (lines.length === 0) {
    const item = { success: false, message: '', error: 'No output' };
    return { ...item, output: [item] };
  }
  const output = lines.map((line): PlainResultItem => {
    if (line.startsWith('Error: ')) {
      return { success: false, message: '', error: line.slice(7) };
    }
    return { success: true, message: line, error: '' };
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

// With real settings defaults (tools.enableEditHealing: true), a context
// mismatch would enter the real patch-healing provider path, so tests default
// to a deterministic no-op healer. The healing integration tests below inject
// their own mock explicitly and are unaffected.
const noopPatchHealing = async (): Promise<{ wasModified: false }> => ({
  wasModified: false,
});

function createTool(settingsService = createMockSettingsService()) {
  return createApplyPatchToolDefinition({
    loggingService: mockLoggingService,
    settingsService,
    patchHealing: noopPatchHealing,
  });
}

it.sequential('create_file: creates a new file with content', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'new-file.txt';

    const result = await tool.execute({
      patch: ['*** Begin Patch', `*** Add File: ${filePath}`, '+Hello World', '*** End Patch'].join('\n'),
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

    const result = await tool.execute({
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' Hello',
        '-World',
        '+Universe',
        '*** End Patch',
      ].join('\n'),
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
          patch: [
            '*** Begin Patch',
            `*** Update File: ${filePath}`,
            '@@',
            `-${token}`,
            `+done_${index}`,
            '*** End Patch',
          ].join('\n'),
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
      patch: [
        '*** Begin Patch',
        '*** Add File: batch.txt',
        '+Hello',
        '+World',
        '*** Update File: batch.txt',
        '@@',
        ' Hello',
        '-World',
        '+Universe',
        '*** End Patch',
      ].join('\n'),
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

it.sequential('execute: applies an upstream multi-file patch including move and delete', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    await fs.writeFile(path.join(dir, 'old.txt'), 'before\n');
    await fs.writeFile(path.join(dir, 'remove.txt'), 'remove\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: old.txt',
      '*** Move to: moved.txt',
      '@@',
      '-before',
      '+after',
      '*** Delete File: remove.txt',
      '*** End Patch',
    ].join('\n');
    const result = await tool.execute({ patch });

    expect(parsePlainResult(result).output.every((item) => item.success)).toBe(true);
    await expect(fs.readFile(path.join(dir, 'old.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, 'remove.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, 'moved.txt'), 'utf8')).resolves.toBe('after\n');
  });
});

it.sequential('execute: rejects a non-envelope patch argument', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({ patch: '@@\n Hello\n-World\n+Universe' });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error).toContain('*** Begin Patch');
  });
});

it.sequential('execute: canonical envelope creates, updates, moves, and deletes end to end', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    await fs.writeFile(path.join(dir, 'edit.txt'), 'alpha\nbeta\n');
    await fs.writeFile(path.join(dir, 'gone.txt'), 'bye\n');
    await fs.writeFile(path.join(dir, 'relocate.txt'), 'old home\n');

    const result = await tool.execute({
      patch: [
        '*** Begin Patch',
        '*** Add File: fresh.txt',
        '+new',
        '+file',
        '*** Update File: edit.txt',
        '@@',
        ' alpha',
        '-beta',
        '+BETA',
        '*** Update File: relocate.txt',
        '*** Move to: moved.txt',
        '@@',
        '-old home',
        '+new home',
        '*** Delete File: gone.txt',
        '*** End Patch',
      ].join('\n'),
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output.every((item) => item.success)).toBe(true);
    await expect(fs.readFile(path.join(dir, 'fresh.txt'), 'utf8')).resolves.toBe('new\nfile\n');
    await expect(fs.readFile(path.join(dir, 'edit.txt'), 'utf8')).resolves.toBe('alpha\nBETA\n');
    await expect(fs.readFile(path.join(dir, 'moved.txt'), 'utf8')).resolves.toBe('new home\n');
    await expect(fs.readFile(path.join(dir, 'relocate.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, 'gone.txt'))).rejects.toThrow();
  });
});

it.sequential('execute: canonical single-file envelope carries its own path', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const result = await tool.execute({
      patch: ['*** Begin Patch', '*** Add File: real.txt', '+hello', '*** End Patch'].join('\n'),
    });

    expect(parsePlainResult(result).output[0].success).toBe(true);
    await expect(fs.readFile(path.join(dir, 'real.txt'), 'utf8')).resolves.toBe('hello\n');
  });
});

it.sequential('needsApproval: rejects a non-envelope patch without running validation', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({ patch: 'garbage' });
    expect(result).toBe(true);
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
      patch: ['*** Begin Patch', '*** Add File: ../outside.txt', '+content', '*** End Patch'].join('\n'),
    });
    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: yolo mode bypasses outside-workspace write approval', async () => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService({ 'shell.autoApproveMode': 'always', 'sandbox.enabled': false }));
    const result = await tool.needsApproval({
      patch: ['*** Begin Patch', '*** Add File: ../outside.txt', '+content', '*** End Patch'].join('\n'),
    });
    expect(result).toBe(false);
  });
});

it.sequential('needsApproval: auto-approves for create/update inside cwd', async () => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());

    const result = await tool.needsApproval({
      patch: ['*** Begin Patch', '*** Add File: inside.txt', '+content', '*** End Patch'].join('\n'),
    });
    expect(result).toBe(false);
  });
});

it.sequential('needsApproval: requires approval for a symlink target outside the workspace', async () => {
  await withTempDir(async (workspaceDir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-apply-patch-outside-'));
    try {
      const outsidePath = path.join(outsideDir, 'target.txt');
      await fs.writeFile(outsidePath, 'outside content\n');
      await fs.symlink(outsidePath, path.join(workspaceDir, 'link.txt'));

      const tool = createTool();
      const result = await tool.needsApproval({
        patch: [
          '*** Begin Patch',
          '*** Update File: link.txt',
          '@@',
          '-outside content',
          '+should require approval',
          '*** End Patch',
        ].join('\n'),
      });

      expect(result).toBe(true);
      await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('outside content\n');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

it.sequential('needsApproval: requires approval for envelope parse failures (fail-closed)', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    // Structural envelope failures (no operations to path-scope) require
    // approval; execute reports the syntax error without touching the fs.
    const result = await tool.needsApproval({
      patch: '*** Begin Patch\n*** End Patch',
    });
    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: update_file missing target requires approval', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.needsApproval({
      patch: ['*** Begin Patch', '*** Update File: missing.txt', '@@ anything', '-old', '+new', '*** End Patch'].join(
        '\n',
      ),
    });
    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: update_file malformed diff auto-approves when file exists', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'existing.txt'), 'line 1\nline 2');
    const tool = createTool();
    const result = await tool.needsApproval({
      patch: ['*** Begin Patch', '*** Update File: existing.txt', '@@', ' garbage', '*** End Patch'].join('\n'),
    });
    expect(result).toBe(false);
  });
});

it.sequential('execute: rejects a bare headerless diff with proper error', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({ patch: '@@\n Hello\n-World\n+Universe' });
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('*** Begin Patch')).toBe(true);
  });
});

it.sequential('execute: detailed error for unified diff headers', async () => {
  await withTempDir(async () => {
    const tool = createTool();
    const result = await tool.execute({
      patch: [
        '*** Begin Patch',
        '*** Add File: test.txt',
        '--- a/test.txt',
        '+++ b/test.txt',
        '+Hello',
        '*** End Patch',
      ].join('\n'),
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
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@ -1,2 +1,2 @@',
        ' Hello',
        '-World',
        '+Universe',
        ' line missing',
        '*** End Patch',
      ].join('\n'),
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
      patch: ['*** Begin Patch', '*** Add File: test.txt', '10: +Hello', '*** End Patch'].join('\n'),
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
      patch: ['*** Begin Patch', '*** Add File: test.txt', 'Hello', '*** End Patch'].join('\n'),
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
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' line one',
        ' line missing',
        ' line three',
        '*** End Patch',
      ].join('\n'),
    });
    const parsed1 = parsePlainResult(result1);
    expect(parsed1.output[0].success).toBe(false);
    expect(parsed1.output[0].error.includes('context block was not found')).toBe(true);

    // Indentation mismatch (with a missing line to force application failure)
    const result2 = await tool.execute({
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' line one',
        ' line two',
        ' line missing',
        ' line three',
        '*** End Patch',
      ].join('\n'), // envelope has 0 spaces for 'line two', file has 2 spaces
    });
    const parsed2 = parsePlainResult(result2);
    expect(parsed2.output[0].success).toBe(false);
    expect(parsed2.output[0].error.includes('Mismatch details')).toBe(true);
  });
});

it.sequential('execute: context mismatch suggests nearby candidate blocks when individual lines exist', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(
      absPath,
      'function alpha() {\n  const shared = true;\n  return 1;\n}\n\nfunction beta() {\n  const shared = true;\n  return 2;\n}\n',
    );

    const result = await tool.execute({
      patch: [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' function alpha() {',
        '   const shared = true;',
        '   return 2;',
        ' }',
        '*** End Patch',
      ].join('\n'),
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error).toContain('Closest matching blocks:');
    expect(parsed.output[0].error).toContain('lines 1-4: 3/4 context lines matched');
    expect(parsed.output[0].error).toContain('lines 6-9: 3/4 context lines matched');
    expect(parsed.output[0].error).toContain(
      'The patch is ambiguous. Add a stronger @@ anchor or use a smaller context block.',
    );
  });
});

it.sequential('execute: create_file writes outside workspace when the call has been approved', async () => {
  // Use a workspace dir outside /tmp so the /tmp exception in resolveWorkspacePath
  // does not mask the workspace boundary check.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-apply-patch-'));
  const originalCwd = process.cwd;
  process.cwd = () => workspaceDir;
  try {
    const tool = createTool();
    const outsidePath = path.join(path.dirname(workspaceDir), 'outside-approved.txt');
    await fs.rm(outsidePath, { force: true });

    const result = await tool.execute({
      patch: ['*** Begin Patch', '*** Add File: ../outside-approved.txt', '+approved content', '*** End Patch'].join(
        '\n',
      ),
    });

    expect(result).not.toContain('outside workspace');
    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message!.startsWith('Created')).toBe(true);
    expect((await fs.readFile(outsidePath, 'utf8')).trim()).toBe('approved content');
  } finally {
    process.cwd = originalCwd;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(workspaceDir), 'outside-approved.txt'), { force: true });
  }
});

it.sequential('execute: heals stale context in apply_patch when enabled and patchHealing succeeds', async () => {
  await withTempDir(async (dir) => {
    const mockPatchHealing = vi.fn().mockResolvedValue({
      wasModified: true,
      healedDiff: [
        '@@ function computeTotal',
        ' function computeTotal(items: number[]): number {',
        '-  let sum = 0;',
        '+  let sum = 100;',
        '   for (const item of items) {',
      ].join('\n'),
    });

    const mockSettingsService = createMockSettingsService({ 'tools.enableEditHealing': true });

    const tool = createApplyPatchToolDefinition({
      loggingService: mockLoggingService,
      settingsService: mockSettingsService,
      patchHealing: mockPatchHealing,
    });

    const filePath = 'calc.ts';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(
      absPath,
      'function computeTotal(items: number[]): number {\n  let sum = 0;\n  for (const item of items) {\n  }\n}\n',
    );

    const stalePatch = [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ function calculateTotal',
      ' function calculateTotal(items: number[]): number {',
      '-  let sum = 0;',
      '+  let sum = 100;',
      '   for (const item of items) {',
      '*** End Patch',
    ].join('\n');

    const result = await tool.execute({ patch: stalePatch });

    expect(mockPatchHealing).toHaveBeenCalled();
    expect(result).toContain('(healed)');
    const updatedContent = await fs.readFile(absPath, 'utf8');
    expect(updatedContent).toContain('let sum = 100;');
  });
});

it.sequential('execute: falls back to error when tools.enableEditHealing is false', async () => {
  await withTempDir(async (dir) => {
    const mockPatchHealing = vi.fn();
    const mockSettingsService = createMockSettingsService({ 'tools.enableEditHealing': false });

    const tool = createApplyPatchToolDefinition({
      loggingService: mockLoggingService,
      settingsService: mockSettingsService,
      patchHealing: mockPatchHealing,
    });

    const filePath = 'calc.ts';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'function computeTotal(items: number[]): number {\n  let sum = 0;\n}\n');

    const stalePatch2 = [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ function calculateTotal',
      ' function calculateTotal(items: number[]): number {',
      '-  let sum = 0;',
      '+  let sum = 100;',
      '}',
      '*** End Patch',
    ].join('\n');

    const result = await tool.execute({ patch: stalePatch2 });

    expect(mockPatchHealing).not.toHaveBeenCalled();
    expect(result).toContain('Error: Invalid patch:');
  });
});

it.sequential('needsApproval allows applying patch in SANDBOX_TEMP_DIR without approval', async () => {
  await withTempDir(async () => {
    const tool = createApplyPatchToolDefinition({
      loggingService: mockLoggingService,
      settingsService: createMockSettingsService({ 'shell.autoApproveMode': 'auto' }),
    });

    const tempFilePath = path.join(SANDBOX_TEMP_DIR, 'scratch-patch.txt');
    await fs.writeFile(tempFilePath, 'original text\n', 'utf8');

    try {
      const result = await tool.needsApproval({
        patch: [
          '*** Begin Patch',
          `*** Update File: ${tempFilePath}`,
          '@@',
          '-original text',
          '+patched text',
          '*** End Patch',
        ].join('\n'),
      });

      expect(result).toBe(false);
    } finally {
      await fs.rm(tempFilePath, { force: true });
    }
  });
});

it.sequential('execute create_file records created file in sessionAccess', async () => {
  await withTempDir(async (dir) => {
    const sessionAccess = new SessionAccessState(
      createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }),
    );
    const tool = createApplyPatchToolDefinition({
      loggingService: mockLoggingService,
      settingsService: createMockSettingsService(),
      sessionAccess,
    });

    const targetFile = 'patch-created.txt';
    const result = await tool.execute({
      patch: ['*** Begin Patch', `*** Add File: ${targetFile}`, '+created with patch', '*** End Patch'].join('\n'),
    });

    expect(result).toContain('Created patch-created.txt');
    expect(sessionAccess.isCreatedInSession(targetFile, dir)).toBe(true);
    expect(sessionAccess.isCreatedInSession(path.join(dir, targetFile))).toBe(true);
  });
});
