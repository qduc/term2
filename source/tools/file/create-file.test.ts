import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createCreateFileToolDefinition } from './create-file.js';
import { ExecutionContext } from '../../services/execution-context.js';
import type { ISSHService, ILoggingService } from '../../services/service-interfaces.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-create-file-'));

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
  return createCreateFileToolDefinition({
    loggingService: mockLoggingService,
    settingsService,
  });
}

function createRemoteTool(remoteDir: string, files: Map<string, string>) {
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    readFile: async (filePath: string) => {
      if (!files.has(filePath)) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return files.get(filePath) ?? '';
    },
    writeFile: async (filePath: string, content: string) => {
      files.set(filePath, content);
    },
    mkdir: async () => {},
  };

  return createCreateFileToolDefinition({
    loggingService: mockLoggingService,
    settingsService: createMockSettingsService(),
    executionContext: new ExecutionContext(sshService, remoteDir),
  });
}

function extractOverwriteCode(error: string): string {
  const match = error.match(/\b([a-f0-9]{6})\b/);
  if (!match) {
    throw new Error(`Expected overwrite code in error message: ${error}`);
  }
  return match[1];
}

it.sequential('parameters default overwrite to false', () => {
  const tool = createTool();

  const parsed = tool.parameters.safeParse({ path: 'new.txt', content: 'content' });

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.overwrite).toBe(false);
  }
});

it.sequential('parameters accept overwrite true', () => {
  const tool = createTool();

  expect(tool.parameters.safeParse({ path: 'new.txt', content: 'content', overwrite: true }).success).toBe(true);
});

it.sequential('parameters reject overwrite null', () => {
  const tool = createTool();

  expect(tool.parameters.safeParse({ path: 'new.txt', content: 'content', overwrite: null }).success).toBe(false);
});

it.sequential('needsApproval auto-approves creation when inside workspace', async () => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'new-file.txt';

    const result = await tool.needsApproval({
      path: filePath,
      content: 'initial content',
    });

    expect(result).toBe(false);
  });
});

it.sequential('execute creates a new file and returns success', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'test-file.txt';
    const absPath = path.join(dir, filePath);
    const content = 'hello world';

    const result = await tool.execute({
      path: filePath,
      content: content,
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message!.includes(filePath)).toBe(true);

    const createdContent = await fs.readFile(absPath, 'utf8');
    expect(createdContent).toBe(content);
  });
});

it.sequential('execute returns overwrite confirmation and preserves existing file', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const result = await tool.execute({
      path: filePath,
      content: 'new content',
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(false);
    expect(parsed.output[0].error.includes('confirm')).toBe(true);
    const code = extractOverwriteCode(parsed.output[0].error);
    expect(code.length).toBe(6);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('original');
  });
});

it.sequential('execute overwrites using the confirmation code and original content', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });

    const firstParsed = parsePlainResult(firstResult);
    const code = extractOverwriteCode(firstParsed.output[0].error);

    const secondResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
      overwrite: true,
      confirmOverwriteCode: code,
    });

    const secondParsed = parsePlainResult(secondResult);
    expect(secondParsed.output[0].success).toBe(true);
    expect(secondParsed.output[0].message.includes('Overwrote')).toBe(true);

    const fileContent = await fs.readFile(absPath, 'utf8');
    expect(fileContent).toBe('replacement content');
  });
});

it.sequential('execute rejects a wrong overwrite code and preserves the file', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });

    const firstParsed = parsePlainResult(firstResult);
    const code = extractOverwriteCode(firstParsed.output[0].error);

    const secondResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
      overwrite: true,
      confirmOverwriteCode: code === 'ffffff' ? '000000' : 'ffffff',
    });

    const secondParsed = parsePlainResult(secondResult);
    expect(secondParsed.output[0].success).toBe(false);
    expect(secondParsed.output[0].error.includes('confirmation')).toBe(true);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('original');
  });
});

it.sequential('execute treats confirmOverwriteCode string "undefined" as absent', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    // Initiate two-step flow
    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });
    const firstParsed = parsePlainResult(firstResult);
    expect(firstParsed.output[0].success).toBe(false);

    // LLM sends confirmOverwriteCode as the string "undefined" instead of omitting it.
    // normalizeObjectParams strips the "undefined" sentinel so the tool sees it as
    // overwrite=true without a confirmation code, which overwrites directly.
    const { normalizeObjectParams } = await import('../../lib/tool-invoke.js');
    const rawParams = {
      path: filePath,
      content: 'replacement content',
      overwrite: true,
      confirmOverwriteCode: 'undefined',
    };
    const normalized = normalizeObjectParams(rawParams, tool.parameters) as any;
    expect(normalized.confirmOverwriteCode, 'string "undefined" should be stripped').toBe(undefined);

    const secondResult = await tool.execute(normalized);
    const secondParsed = parsePlainResult(secondResult);
    expect(secondParsed.output[0].success).toBe(true);
    const diskContent = await fs.readFile(absPath, 'utf8');
    expect(diskContent).toBe('replacement content');
  });
});

it.sequential('execute overwrites directly when overwrite=true without confirmation code', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const result = await tool.execute({
      path: filePath,
      content: 'replacement content',
      overwrite: true,
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);
    expect(parsed.output[0].message.includes('Overwrote')).toBe(true);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('replacement content');
  });
});

it.sequential('execute invalidates pending code after successful overwrite', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    // Step 1: initiate the two-step flow
    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });
    const code = extractOverwriteCode(parsePlainResult(firstResult).error);

    // Step 2: overwrite directly (no code)
    const secondResult = await tool.execute({
      path: filePath,
      content: 'new content',
      overwrite: true,
    });
    expect(parsePlainResult(secondResult).success).toBe(true);

    // Step 3: the old confirmation code should no longer work
    const thirdResult = await tool.execute({
      path: filePath,
      content: 'should not work',
      overwrite: true,
      confirmOverwriteCode: code,
    });
    const thirdParsed = parsePlainResult(thirdResult);
    expect(thirdParsed.success).toBe(false);
    expect(thirdParsed.error.includes('No matching overwrite confirmation')).toBe(true);

    // File should still have the content from step 2
    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('new content');
  });
});

it.sequential('execute overwrites directly even when stale pending entry exists from prior attempt', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    // Step 1: initiate the two-step flow (creates pending entry)
    const firstResult = await tool.execute({
      path: filePath,
      content: 'stale content',
    });
    const firstParsed = parsePlainResult(firstResult);
    expect(firstParsed.output[0].success).toBe(false);
    expect(firstParsed.output[0].error.includes('confirm')).toBe(true);

    // Step 2: agent skips the code and overwrites directly with new content
    const secondResult = await tool.execute({
      path: filePath,
      content: 'new content',
      overwrite: true,
    });

    const secondParsed = parsePlainResult(secondResult);
    expect(secondParsed.output[0].success).toBe(true);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('new content');
  });
});

it.sequential('execute creates a new file even when overwrite is true', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'fresh.txt';
    const absPath = path.join(dir, filePath);

    const result = await tool.execute({
      path: filePath,
      content: 'fresh content',
      overwrite: true,
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const content = await fs.readFile(absPath, 'utf8');
    expect(content).toBe('fresh content');
  });
});

it.sequential('execute overwrites a remote existing file after confirmation', async () => {
  const remoteDir = '/remote/workspace';
  const filePath = 'existing.txt';
  const absPath = path.posix.join(remoteDir, filePath);
  const files = new Map<string, string>([[absPath, 'original']]);
  const tool = createRemoteTool(remoteDir, files);

  const firstResult = await tool.execute({
    path: filePath,
    content: 'replacement content',
  });

  const firstParsed = parsePlainResult(firstResult);
  const code = extractOverwriteCode(firstParsed.output[0].error);
  expect(files.get(absPath)).toBe('original');

  const secondResult = await tool.execute({
    path: filePath,
    content: 'replacement content',
    overwrite: true,
    confirmOverwriteCode: code,
  });

  const secondParsed = parsePlainResult(secondResult);
  expect(secondParsed.output[0].success).toBe(true);
  expect(files.get(absPath)).toBe('replacement content');
});

it.sequential('execute creates parent directories automatically', async () => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'subdir/deep/file.txt';
    const absPath = path.join(dir, filePath);
    const content = 'deep content';

    const result = await tool.execute({
      path: filePath,
      content: content,
    });

    const parsed = parsePlainResult(result);
    expect(parsed.output[0].success).toBe(true);

    const createdContent = await fs.readFile(absPath, 'utf8');
    expect(createdContent).toBe(content);
  });
});

it.sequential('formatCommandMessage returns correct base message structure', async () => {
  const tool = createTool();
  const callArgs = { path: 'new.txt', content: 'test' };

  const item = {
    rawItem: {
      arguments: JSON.stringify(callArgs),
    },
    output: 'Created new.txt',
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());

  expect(messages.length).toBe(1);
  expect(messages[0].command).toBe('create_file "new.txt"');
  expect(messages[0].success).toBe(true);
  expect(messages[0].toolName).toBe('create_file');
  expect(messages[0].toolArgs).toEqual(callArgs);
});

it.sequential('needsApproval requires approval and handles error when path is outside workspace', async () => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());
    const filePath = '../outside-file.txt';

    const result = await tool.needsApproval({
      path: filePath,
      content: 'initial content',
    });

    expect(result).toBe(true);
  });
});

it.sequential('execute writes outside workspace when the call has been approved', async () => {
  // Use a workspace dir outside /tmp so the /tmp exception in resolveWorkspacePath
  // does not mask the workspace boundary check.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-create-file-'));
  const originalCwd = process.cwd;
  process.cwd = () => workspaceDir;
  try {
    const tool = createTool(createMockSettingsService());
    const outsidePath = path.join(path.dirname(workspaceDir), 'outside-approved.txt');
    await fs.rm(outsidePath, { force: true });

    const result = await tool.execute({
      path: '../outside-approved.txt',
      content: 'approved content',
    });

    expect(result).not.toContain('outside workspace');
    expect(result).toBe('Created ../outside-approved.txt');
    expect(await fs.readFile(outsidePath, 'utf8')).toBe('approved content');
  } finally {
    process.cwd = originalCwd;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(workspaceDir), 'outside-approved.txt'), { force: true });
  }
});
