import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createCreateFileToolDefinition } from './create-file.js';
import { ExecutionContext } from '../../services/execution-context.js';
import type { ISSHService, ILoggingService } from '../../services/service-interfaces.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

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

test.serial('parameters default overwrite to false', (t) => {
  const tool = createTool();

  const parsed = tool.parameters.safeParse({ path: 'new.txt', content: 'content' });

  t.true(parsed.success);
  if (parsed.success) {
    t.false(parsed.data.overwrite);
  }
});

test.serial('parameters accept overwrite true', (t) => {
  const tool = createTool();

  t.true(tool.parameters.safeParse({ path: 'new.txt', content: 'content', overwrite: true }).success);
});

test.serial('parameters reject overwrite null', (t) => {
  const tool = createTool();

  t.false(tool.parameters.safeParse({ path: 'new.txt', content: 'content', overwrite: null }).success);
});

test.serial('needsApproval auto-approves creation when inside workspace', async (t) => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());
    const filePath = 'new-file.txt';

    const result = await tool.needsApproval({
      path: filePath,
      content: 'initial content',
    });

    t.false(result);
  });
});

test.serial('execute creates a new file and returns success', async (t) => {
  await withTempDir(async (dir) => {
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
});

test.serial('execute returns overwrite confirmation and preserves existing file', async (t) => {
  await withTempDir(async (dir) => {
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
    t.true(parsed.error.includes('confirm'));
    const code = extractOverwriteCode(parsed.error);
    t.is(code.length, 6);

    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'original');
  });
});

test.serial('execute overwrites using the confirmation code and original content', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });

    const firstParsed = JSON.parse(firstResult);
    const code = extractOverwriteCode(firstParsed.error);

    const secondResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
      overwrite: true,
      confirmOverwriteCode: code,
    });

    const secondParsed = JSON.parse(secondResult);
    t.true(secondParsed.success);
    t.true(secondParsed.message.includes('Overwrote'));

    const fileContent = await fs.readFile(absPath, 'utf8');
    t.is(fileContent, 'replacement content');
  });
});

test.serial('execute rejects a wrong overwrite code and preserves the file', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'existing.txt';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, 'original');

    const firstResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
    });

    const firstParsed = JSON.parse(firstResult);
    const code = extractOverwriteCode(firstParsed.error);

    const secondResult = await tool.execute({
      path: filePath,
      content: 'replacement content',
      overwrite: true,
      confirmOverwriteCode: code === 'ffffff' ? '000000' : 'ffffff',
    });

    const secondParsed = JSON.parse(secondResult);
    t.false(secondParsed.success);
    t.true(secondParsed.error.includes('confirmation'));

    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'original');
  });
});

test.serial('execute treats confirmOverwriteCode string "undefined" as absent', async (t) => {
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
    const firstParsed = JSON.parse(firstResult);
    t.false(firstParsed.success);

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
    t.is(normalized.confirmOverwriteCode, undefined, 'string "undefined" should be stripped');

    const secondResult = await tool.execute(normalized);
    const secondParsed = JSON.parse(secondResult);
    t.true(secondParsed.success);
    const diskContent = await fs.readFile(absPath, 'utf8');
    t.is(diskContent, 'replacement content');
  });
});

test.serial('execute overwrites directly when overwrite=true without confirmation code', async (t) => {
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

    const parsed = JSON.parse(result);
    t.true(parsed.success);
    t.true(parsed.message.includes('Overwrote'));

    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'replacement content');
  });
});

test.serial('execute invalidates pending code after successful overwrite', async (t) => {
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
    const code = extractOverwriteCode(JSON.parse(firstResult).error);

    // Step 2: overwrite directly (no code)
    const secondResult = await tool.execute({
      path: filePath,
      content: 'new content',
      overwrite: true,
    });
    t.true(JSON.parse(secondResult).success);

    // Step 3: the old confirmation code should no longer work
    const thirdResult = await tool.execute({
      path: filePath,
      content: 'should not work',
      overwrite: true,
      confirmOverwriteCode: code,
    });
    const thirdParsed = JSON.parse(thirdResult);
    t.false(thirdParsed.success);
    t.true(thirdParsed.error.includes('No matching overwrite confirmation'));

    // File should still have the content from step 2
    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'new content');
  });
});

test.serial('execute overwrites directly even when stale pending entry exists from prior attempt', async (t) => {
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
    const firstParsed = JSON.parse(firstResult);
    t.false(firstParsed.success);
    t.true(firstParsed.error.includes('confirm'));

    // Step 2: agent skips the code and overwrites directly with new content
    const secondResult = await tool.execute({
      path: filePath,
      content: 'new content',
      overwrite: true,
    });

    const secondParsed = JSON.parse(secondResult);
    t.true(secondParsed.success);

    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'new content');
  });
});

test.serial('execute creates a new file even when overwrite is true', async (t) => {
  await withTempDir(async (dir) => {
    const tool = createTool();
    const filePath = 'fresh.txt';
    const absPath = path.join(dir, filePath);

    const result = await tool.execute({
      path: filePath,
      content: 'fresh content',
      overwrite: true,
    });

    const parsed = JSON.parse(result);
    t.true(parsed.success);

    const content = await fs.readFile(absPath, 'utf8');
    t.is(content, 'fresh content');
  });
});

test.serial('execute overwrites a remote existing file after confirmation', async (t) => {
  const remoteDir = '/remote/workspace';
  const filePath = 'existing.txt';
  const absPath = path.posix.join(remoteDir, filePath);
  const files = new Map<string, string>([[absPath, 'original']]);
  const tool = createRemoteTool(remoteDir, files);

  const firstResult = await tool.execute({
    path: filePath,
    content: 'replacement content',
  });

  const firstParsed = JSON.parse(firstResult);
  const code = extractOverwriteCode(firstParsed.error);
  t.is(files.get(absPath), 'original');

  const secondResult = await tool.execute({
    path: filePath,
    content: 'replacement content',
    overwrite: true,
    confirmOverwriteCode: code,
  });

  const secondParsed = JSON.parse(secondResult);
  t.true(secondParsed.success);
  t.is(files.get(absPath), 'replacement content');
});

test.serial('execute creates parent directories automatically', async (t) => {
  await withTempDir(async (dir) => {
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
});

test.serial('formatCommandMessage returns correct base message structure', async (t) => {
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
});

test.serial('needsApproval requires approval and handles error when path is outside workspace', async (t) => {
  await withTempDir(async () => {
    const tool = createTool(createMockSettingsService());
    const filePath = '../outside-file.txt';

    const result = await tool.needsApproval({
      path: filePath,
      content: 'initial content',
    });

    t.true(result);
  });
});
