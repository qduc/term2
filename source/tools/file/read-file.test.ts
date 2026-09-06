import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createReadFileToolDefinition } from './read-file.js';
import { coerceToText } from '../format-helpers.js';
import { SessionAccessState } from '../../services/session/session-access-state.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

it('orchestrator read_file description permits direct inspection', () => {
  const tool = createReadFileToolDefinition({ orchestratorMode: true });

  expect(tool.description).toContain('Inspect a known file directly');
  expect(tool.description).not.toContain('to verify a specific claim');
});

it('standard read_file description does not redirect unfamiliar code inspection to explorer', () => {
  const tool = createReadFileToolDefinition();

  expect(tool.description).not.toContain('run_subagent');
  expect(tool.description).not.toContain('use run_subagent with an explorer');
});

const readFileToolDefinition = createReadFileToolDefinition();
const readFileToolDefinitionAllowOutside = createReadFileToolDefinition({
  allowOutsideWorkspace: true,
});

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-'));
  const workspaceDir = path.join(rootDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  // Mock process.cwd (treat workspaceDir as the "workspace")
  process.cwd = () => workspaceDir;

  try {
    await run(workspaceDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

it.sequential('needsApproval: returns false for read-only operation', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: 'test.txt',
    });
    expect(result).toBe(false);
  });
});

it.sequential('schema: optional line params can be omitted and null is rejected', async () => {
  await withTempDir(async () => {
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt' }).success).toBe(true);
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt', start_line: null }).success).toBe(false);
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt', end_line: null }).success).toBe(false);
  });
});

it.sequential('execute: successfully reads a file', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Hello\nWorld\nFrom\nFile';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = (await readFileToolDefinition.execute({
      path: filePath,
    })) as string;

    // Result should include header and content
    expect(result.includes('File: test.txt')).toBe(true);
    expect(result.includes('4 lines')).toBe(true);
    expect(result.includes('Hello')).toBe(true);
    expect(result.includes('World')).toBe(true);
    expect(result.includes('From')).toBe(true);
    expect(result.includes('File')).toBe(true);
  });
});

it.sequential('execute: reads file with line range', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = (await readFileToolDefinition.execute({
      path: filePath,
      start_line: 2,
      end_line: 4,
    })) as string;

    // Should only include lines 2-4
    expect(result.includes('[lines 2-4]')).toBe(true);
    expect(result.includes('Line 1')).toBe(false);
    expect(result.includes('Line 2')).toBe(true);
    expect(result.includes('Line 3')).toBe(true);
    expect(result.includes('Line 4')).toBe(true);
    expect(result.includes('Line 5')).toBe(false);
  });
});

it.sequential('execute: reads file from start_line to end', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = (await readFileToolDefinition.execute({
      path: filePath,
      start_line: 3,
    })) as string;

    // Should include lines 3-5
    expect(result.includes('[lines 3-5]')).toBe(true);
    expect(result.includes('Line 1')).toBe(false);
    expect(result.includes('Line 2')).toBe(false);
    expect(result.includes('Line 3')).toBe(true);
    expect(result.includes('Line 4')).toBe(true);
    expect(result.includes('Line 5')).toBe(true);
  });
});

it.sequential('needsApproval: prompts for path outside workspace', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: '/etc/outside.txt',
    });

    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: yolo mode bypasses the workspace boundary for reads', async () => {
  await withTempDir(async () => {
    const tool = createReadFileToolDefinition({
      settingsService: createMockSettingsService({ 'shell.autoApproveMode': 'always', 'sandbox.enabled': false }),
    });
    const result = await tool.needsApproval({ path: '/etc/outside.txt' });
    expect(result).toBe(false);
  });
});

it.sequential('needsApproval: does not prompt for descendants of a folder allowed for the session', async () => {
  await withTempDir(async (workspaceDir) => {
    const sessionId = 'read-folder-session';
    const allowedFolder = path.join(workspaceDir, '..', 'docs');
    const sessionAccess = new SessionAccessState({ get: () => undefined, set: () => {} } as any);
    sessionAccess.allowReadFolder(allowedFolder);
    const tool = createReadFileToolDefinition({ sessionAccess });

    try {
      const result = await tool.needsApproval(
        { path: path.join(allowedFolder, 'nested', 'guide.md') },
        { context: { sessionId } },
      );

      expect(result).toBe(false);
    } finally {
      sessionAccess.dispose();
    }
  });
});

it.sequential('needsApproval: does not prompt for discovered skill directories outside workspace', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: path.join(os.homedir(), '.agents', 'skills', 'example-skill', 'SKILL.md'),
    });

    expect(result).toBe(false);
  });
});

it.sequential('execute: reads path outside workspace after approval path resolution', async () => {
  await withTempDir(async (dir) => {
    const outsidePath = path.join(dir, '..', 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\ncontent');

    const result = (await readFileToolDefinition.execute({
      path: '../outside.txt',
    })) as string;

    expect(result.includes('outside')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: in allowOutsideWorkspace mode, can read outside workspace', async () => {
  await withTempDir(async (dir) => {
    const outsidePath = path.join(dir, '..', 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\ncontent');

    const result = (await readFileToolDefinitionAllowOutside.execute({
      path: '../outside.txt',
    })) as string;

    expect(result.includes('outside')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: expands ~ to home directory in allowOutsideWorkspace mode', async () => {
  await withTempDir(async () => {
    // We try to read ~/.ssh/config or something likely to exist,
    // but better to just mock homedir if we could.
    // Given the constraints, we can at least verify it doesn't throw a malformed path error
    // even if the file doesn't exist.
    const result = (await readFileToolDefinitionAllowOutside.execute({
      path: '~/nonexistent_file_for_test_' + Date.now(),
    })) as string;

    // Should not fail with "Operation outside workspace" if expansion worked
    expect(result.includes('Operation outside workspace')).toBe(false);
    expect(result.includes('Error: File not found') || result.includes('ENOENT')).toBe(true);
  });
});

it.sequential('execute: handles file not found', async () => {
  await withTempDir(async () => {
    const result = (await readFileToolDefinition.execute({
      path: 'nonexistent.txt',
    })) as string;

    expect(result.includes('Error')).toBe(true);
    expect(result.includes('ENOENT') || result.includes('not found')).toBe(true);
  });
});

it.sequential('execute: handles empty file', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'empty.txt';
    await fs.writeFile(path.join(dir, filePath), '');

    const result = (await readFileToolDefinition.execute({
      path: filePath,
    })) as string;

    expect(result.trim()).toBe('');
  });
});

it.sequential('execute: bounds oversize files and spools full content with shell note', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'huge.txt';
    const body = `${'x'.repeat(2000)}SENTINEL-ONLY-IN-FULL${'y'.repeat(2000)}`;
    await fs.writeFile(path.join(dir, filePath), body);

    const tool = createReadFileToolDefinition({ maxResultBytes: 400 });
    const result = (await tool.execute({ path: filePath })) as string;

    expect(result).toContain('File: huge.txt');
    expect(result).toContain('Full output saved to');
    expect(result).not.toContain('SENTINEL-ONLY-IN-FULL');

    const match = result.match(/Full output saved to `([^`]+)`/);
    expect(match).toBeTruthy();
    const artifact = await fs.readFile(match![1]!, 'utf8');
    expect(artifact).toContain('SENTINEL-ONLY-IN-FULL');
    expect(artifact).toContain('File: huge.txt');
  });
});

it.sequential('execute: refuses binary files without dumping contents', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'blob.bin';
    await fs.writeFile(path.join(dir, filePath), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x10]));

    const result = (await readFileToolDefinition.execute({ path: filePath })) as string;

    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('binary');
    expect(result).not.toContain('\u0000');
  });
});

it.sequential('execute: returns supported image files as a multimodal tool result', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'screenshot.png';
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    await fs.writeFile(path.join(dir, filePath), imageBytes);

    const result = (await readFileToolDefinition.execute({ path: filePath })) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'Image: screenshot.png (12 bytes, image/png)' });
    expect(result[1]).toEqual({
      type: 'image',
      image: { data: imageBytes.toString('base64'), mediaType: 'image/png' },
    });
  });
});

it('formatting a multimodal result does not expose encoded image data as text', () => {
  expect(
    coerceToText([
      { type: 'text', text: 'Image: screenshot.png' },
      { type: 'image', image: { data: 'very-large-base64-payload', mediaType: 'image/png' } },
    ]),
  ).toBe('Image: screenshot.png');
});

it.sequential('execute: truncates on a multibyte character boundary without corrupting UTF-8', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'unicode.txt';
    // Each "界" is 3 UTF-8 bytes; pad so the cap lands mid-character for naive slicers.
    const content = `start${'界'.repeat(80)}end`;
    await fs.writeFile(path.join(dir, filePath), content);

    const tool = createReadFileToolDefinition({ maxResultBytes: 40 });
    const result = (await tool.execute({ path: filePath })) as string;

    expect(result).toContain('Full output saved to');
    expect(result).not.toContain('\uFFFD');
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });
});

it.sequential('execute: handles line range beyond file length', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'short.txt';
    const content = 'Line 1\nLine 2';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = (await readFileToolDefinition.execute({
      path: filePath,
      start_line: 1,
      end_line: 10,
    })) as string;

    // Should only include available lines
    expect(result.includes('Line 1')).toBe(true);
    expect(result.includes('Line 2')).toBe(true);
    expect(result.includes('2 lines')).toBe(true);
  });
});

describe('read_file scripted cap (file over the byte cap)', () => {
  // A temp fixture, not a real repo file read through a relative path. The
  // earlier version read source/tools/system/shell.ts and asserted it stayed
  // over 50,000 bytes, which coupled this test both to unrelated source size
  // and — because a relative path resolves through process.cwd() — to any
  // other lane file that patches process.cwd while sharing a worker under
  // --isolate=false. It failed in the lane for exactly that reason.
  it('gives a script the whole file while still truncating for the model', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-cap-'));
    try {
      const target = path.join(dir, 'big.ts');
      // Comfortably over the 40,000-byte context cap.
      const body = Array.from({ length: 1_200 }, (_, i) => `const value${i} = ${'x'.repeat(40)};`).join('\n');
      await fs.writeFile(target, `${body}\n`);
      const raw = await fs.readFile(target, 'utf8');
      const tool = createReadFileToolDefinition({}) as any;

      const direct = String(await tool.execute({ path: target }, {}));
      const scripted = await tool.execute({ path: target }, { scripted: true });
      const lastLine = `${raw.split('\n').length}: `;

      expect(raw.length).toBeGreaterThan(50_000);
      expect(direct.length).toBeLessThan(41_000);
      expect(direct).not.toContain(lastLine);
      // The script gets raw lines and a count field rather than a banner.
      expect(scripted.content.length).toBeGreaterThan(50_000);
      expect(scripted.truncated).toBe(false);
      expect(scripted.totalLines).toBe(raw.split('\n').length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('read_file scripted return shape', () => {
  it('returns fields and raw lines to a script, banner text to a direct call', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-shape-'));
    const target = path.join(dir, 'sample.ts');
    const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
    await fs.writeFile(target, `${body}\n`);
    const tool = createReadFileToolDefinition({}) as any;

    const direct = String(await tool.execute({ path: target }, {}));
    const scripted = await tool.execute({ path: target }, { scripted: true });

    expect(direct).toContain('File: ');
    expect(direct).toContain('1: const v0 = 0;');

    // No banner, no "N: " prefixes: every observed script stripped those by hand.
    expect(typeof scripted).toBe('object');
    expect(scripted.content.split('\n')[0]).toBe('const v0 = 0;');
    expect(scripted.content).not.toContain('File: ');
    expect(scripted.totalLines).toBe(41);
    expect(scripted.truncated).toBe(false);
  });

  it('reports truncation as a field with a retrievable path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-shape-big-'));
    const target = path.join(dir, 'big.ts');
    await fs.writeFile(target, Array.from({ length: 8000 }, (_, i) => `const v${i} = ${i};`).join('\n'));
    const tool = createReadFileToolDefinition({ maxResultBytes: 5_000 }) as any;

    const scripted = await tool.execute({ path: target }, { scripted: true });

    expect(scripted.truncated).toBe(true);
    expect(typeof scripted.fullOutputPath).toBe('string');
  });

  it('rejects operational errors for scripted calls while direct calls return error string', async () => {
    const tool = createReadFileToolDefinition({}) as any;

    // Missing file
    await expect(tool.execute({ path: 'nonexistent-scripted-file.txt' }, { scripted: true })).rejects.toThrow(
      'File not found: nonexistent-scripted-file.txt',
    );
    const directMissing = await tool.execute({ path: 'nonexistent-scripted-file.txt' }, {});
    expect(typeof directMissing).toBe('string');
    expect(directMissing).toContain('Error: File not found');

    // Directory path
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-dir-'));
    try {
      await expect(tool.execute({ path: dir }, { scripted: true })).rejects.toThrow(`Path is a directory: ${dir}`);
      const directDir = await tool.execute({ path: dir }, {});
      expect(typeof directDir).toBe('string');
      expect(directDir).toContain('Error: Path is a directory');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('budgets the full envelope so JSON.stringify(scripted) UTF-8 byteLength <= maxResultBytes with retrieval and Unicode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-envelope-'));
    try {
      const target = path.join(dir, 'unicode.txt');
      // Create text with newlines, quotes, unicode characters (CJK + emojis) that expand under JSON serialization
      const lines = Array.from(
        { length: 200 },
        (_, i) => `Line ${i}: "quoted" \\backslash\\ 日本語 🚀 ${'a'.repeat(40)}`,
      );
      const fullText = lines.join('\n');
      await fs.writeFile(target, fullText);

      const budget = 2_000;
      const tool = createReadFileToolDefinition({ maxResultBytes: budget }) as any;
      const scripted = await tool.execute({ path: target }, { scripted: true });

      expect(scripted.truncated).toBe(true);
      expect(typeof scripted.content).toBe('string');
      expect(typeof scripted.fullOutputPath).toBe('string');

      // The full envelope serialized as JSON MUST fit within the configured UTF-8 byte budget
      const encoded = JSON.stringify(scripted);
      expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(budget);

      // The saved artifact must contain the full untruncated content for retrieval
      const artifactContent = await fs.readFile(scripted.fullOutputPath, 'utf8');
      expect(artifactContent).toBe(fullText);

      // Verify no broken unicode / unpaired surrogate at the end of truncated content
      expect(/[\uD800-\uDBFF]$/.test(scripted.content)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces UTF-8 byte budget on Unicode-heavy CJK content (not UTF-16 characters)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-cjk-'));
    try {
      const target = path.join(dir, 'cjk.txt');
      // Thousands of 3-byte CJK characters:
      const fullText = '界'.repeat(3000);
      await fs.writeFile(target, fullText);

      const budget = 1_000;
      const tool = createReadFileToolDefinition({ maxResultBytes: budget }) as any;
      const scripted = await tool.execute({ path: target }, { scripted: true });

      expect(scripted.truncated).toBe(true);
      const encoded = JSON.stringify(scripted);
      // Byte length in UTF-8 must be <= budget
      expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(budget);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws an error when maxResultBytes is too small to fit the minimum envelope', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-too-small-'));
    try {
      const target = path.join(dir, 'file.txt');
      await fs.writeFile(target, 'some content');

      // 10 bytes is smaller than {"path":"...","totalLines":1,"fromLine":1,"toLine":1,"content":"","truncated":true}
      const budget = 10;
      const tool = createReadFileToolDefinition({ maxResultBytes: budget }) as any;
      await expect(tool.execute({ path: target }, { scripted: true })).rejects.toThrow(
        /Result envelope exceeds budget of 10 bytes/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('omits fullOutputPath when envelope with artifact path would exceed budget but minimal envelope fits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-no-artifact-budget-'));
    try {
      const target = path.join(dir, 'short.txt');
      await fs.writeFile(target, 'a'.repeat(200));

      const minimalEnvelope = {
        path: target,
        totalLines: 1,
        fromLine: 1,
        toLine: 1,
        content: '',
        truncated: true,
      };
      const minBytes = Buffer.byteLength(JSON.stringify(minimalEnvelope), 'utf8');
      // Set budget just enough for minimal envelope + 5 bytes, but not enough for ~70 bytes of fullOutputPath
      const budget = minBytes + 5;
      const tool = createReadFileToolDefinition({ maxResultBytes: budget }) as any;
      const scripted = await tool.execute({ path: target }, { scripted: true });

      expect(scripted.truncated).toBe(true);
      expect(scripted.fullOutputPath).toBeUndefined();
      const encoded = JSON.stringify(scripted);
      expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(budget);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
