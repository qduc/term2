import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { formatShellExecutionOutput } from './shell-output.js';

it('formatShellExecutionOutput saves the full output when truncation occurs', async () => {
  const stdout = `${'x'.repeat(6000)}FULL-ONLY-SENTINEL${'y'.repeat(6000)}`;

  const result = await formatShellExecutionOutput({
    command: 'demo --long-output',
    cwd: '/workspace',
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 120,
    durationMs: 1234,
  });

  expect(result.truncated).toBe(true);
  expect(result.artifactPath).toBeTruthy();
  expect(result.text.includes('exit 0')).toBe(true);
  expect(result.text.includes('Runtime: 1234ms')).toBe(true);
  expect(result.text.includes('Full shell output saved to')).toBe(true);
  expect(
    result.text.includes(
      'Search that file for what you need instead of rerunning the command or changing the filter criteria with a `| grep` pipeline.',
    ),
  ).toBe(true);
  expect(result.text.includes('FULL-ONLY-SENTINEL')).toBe(false);

  const artifactPath = result.artifactPath as string;
  const artifactContents = fs.readFileSync(artifactPath, 'utf8');

  expect(artifactContents.includes('Command: demo --long-output')).toBe(true);
  expect(artifactContents.includes('Working directory: /workspace')).toBe(true);
  expect(artifactContents.includes('Runtime: 1234ms')).toBe(true);
  expect(artifactContents.includes('STDOUT:')).toBe(true);
  expect(artifactContents.includes('STDERR:')).toBe(true);
  expect(artifactContents.includes('FULL-ONLY-SENTINEL')).toBe(true);

  // TODO: // TODO: t.teardown(() => fs.rmSync(path.dirname(artifactPath), { recursive: true, force: true })) needs manual try/finally conversion;
});

it('formatShellExecutionOutput leaves short output unchanged', async () => {
  const result = await formatShellExecutionOutput({
    command: 'printf hello',
    cwd: '/workspace',
    stdout: 'hello',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 1000,
    durationMs: 42,
  });

  expect(result.truncated).toBe(false);
  expect(result.artifactPath).toBe(undefined);
  expect(result.text.includes('Full shell output saved to')).toBe(false);
  expect(result.text).toBe('exit 0\nRuntime: 42ms\nhello');
});
