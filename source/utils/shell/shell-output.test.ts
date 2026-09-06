import { it, expect } from 'vitest';
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
  expect(result.text.includes('Full output saved to')).toBe(true);
  expect(result.text.includes('trimmed')).toBe(true);
  expect(result.text.includes('FULL-ONLY-SENTINEL')).toBe(false);

  const artifactPath = result.artifactPath as string;
  try {
    const artifactContents = fs.readFileSync(artifactPath, 'utf8');

    expect(artifactContents.includes('Command: demo --long-output')).toBe(true);
    expect(artifactContents.includes('Working directory: /workspace')).toBe(true);
    expect(artifactContents.includes('Runtime: 1234ms')).toBe(true);
    expect(artifactContents.includes('STDOUT:')).toBe(true);
    expect(artifactContents.includes('STDERR:')).toBe(true);
    expect(artifactContents.includes('FULL-ONLY-SENTINEL')).toBe(true);
  } finally {
    if (fs.existsSync(artifactPath)) {
      fs.unlinkSync(artifactPath);
    }
  }
});

it('formatShellExecutionOutput truncates few-line large JSON output and spools artifact', async () => {
  const stdout = [
    'Already up to date',
    'Done in 378ms',
    `{"numTotalTests":7000,"results":[${'{"test":"fast"},'.repeat(3000)}{}]}`,
    'Warning: something happened',
  ].join('\n');

  const result = await formatShellExecutionOutput({
    command: 'pnpm exec vitest run --reporter=json',
    cwd: '/workspace',
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 5000,
    durationMs: 500,
  });

  expect(result.truncated).toBe(true);
  expect(result.artifactPath).toBeTruthy();
  expect(result.text.includes('Full output saved to')).toBe(true);
  expect(result.text.length).toBeLessThan(6000);

  const artifactPath = result.artifactPath as string;
  try {
    const artifactContents = fs.readFileSync(artifactPath, 'utf8');
    expect(artifactContents.includes('numTotalTests')).toBe(true);
  } finally {
    if (fs.existsSync(artifactPath)) {
      fs.unlinkSync(artifactPath);
    }
  }
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
  expect(result.text.includes('Full output saved to')).toBe(false);
  expect(result.text).toBe('exit 0\nRuntime: 42ms\nhello');
});

it('formats a child-owned curl timeout as exit 28 rather than a shell timeout', async () => {
  const result = await formatShellExecutionOutput({
    command: 'curl --max-time 10 https://example.com',
    cwd: '/workspace',
    stdout: '',
    stderr: 'curl: (28) Operation timed out',
    exitCode: 28,
    timedOut: false,
  });

  expect(result.text).toContain('exit 28');
  expect(result.text).not.toMatch(/^timeout(?:\n|$)/);
});

it('formatShellExecutionOutput reuses one temp directory and randomizes artifact filenames', async () => {
  const longOutput = 'x'.repeat(8000);

  const first = await formatShellExecutionOutput({
    command: 'demo one',
    cwd: '/workspace',
    stdout: longOutput,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 100,
  });

  const second = await formatShellExecutionOutput({
    command: 'demo two',
    cwd: '/workspace',
    stdout: longOutput,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 100,
  });

  expect(first.truncated).toBe(true);
  expect(second.truncated).toBe(true);
  expect(first.artifactPath).toBeTruthy();
  expect(second.artifactPath).toBeTruthy();

  const firstPath = first.artifactPath as string;
  const secondPath = second.artifactPath as string;

  try {
    expect(path.dirname(firstPath)).toBe(path.dirname(secondPath));
    expect(path.basename(firstPath)).not.toBe(path.basename(secondPath));
    expect(path.basename(firstPath)).toMatch(/^output-\d+-\d+-[a-f0-9]{6}\.txt$/);
    expect(path.basename(secondPath)).toMatch(/^output-\d+-\d+-[a-f0-9]{6}\.txt$/);
  } finally {
    if (fs.existsSync(firstPath)) fs.unlinkSync(firstPath);
    if (fs.existsSync(secondPath)) fs.unlinkSync(secondPath);
  }
});

it('explains a deadline timeout with its effective budget, partial effects, and no-replay note', async () => {
  const result = await formatShellExecutionOutput({
    command: 'pnpm test',
    cwd: '/workspace',
    stdout: 'Test Files 1 passed (1)',
    stderr: '',
    exitCode: null,
    timedOut: true,
    timeoutMs: 900_000,
    timeoutSource: 'invocation',
    durationMs: 900_123,
  });

  expect(result.text.startsWith('timeout')).toBe(true);
  expect(result.text).toContain('Runtime: 900123ms');
  expect(result.text).toContain('Terminated');
  expect(result.text).toContain('explicit 900000ms timeout');
  expect(result.text.toLowerCase()).toContain('output may be partial');
  expect(result.text.toLowerCase()).toContain('does not authorize replaying');
  // Partial output and the artifact reference survive the explanation.
  expect(result.text).toContain('Test Files 1 passed (1)');
});

it('presents a caller cancellation as cancelled, not as a timeout', async () => {
  const result = await formatShellExecutionOutput({
    command: 'watch-receipts.sh receipts state',
    cwd: '/workspace',
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: true,
    cancelled: true,
    durationMs: 61_000,
  });

  expect(result.text.startsWith('cancelled')).toBe(true);
  expect(result.text).not.toMatch(/^timeout(?:\n|$)/);
  expect(result.text).toContain('cancelled before completing');
  expect(result.text.toLowerCase()).toContain('output may be partial');
  expect(result.text).not.toContain('(No output)');
  expect(result.text).not.toContain('does not authorize replaying');
});
