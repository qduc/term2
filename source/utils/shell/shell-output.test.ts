import test from 'ava';
import fs from 'fs';
import path from 'path';
import { formatShellExecutionOutput } from './shell-output.js';

test('formatShellExecutionOutput saves the full output when truncation occurs', async (t) => {
  const stdout = `${'x'.repeat(6000)}FULL-ONLY-SENTINEL${'y'.repeat(6000)}`;

  const result = await formatShellExecutionOutput({
    command: 'demo --long-output',
    cwd: '/workspace',
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 120,
  });

  t.true(result.truncated);
  t.truthy(result.artifactPath);
  t.true(result.text.includes('exit 0'));
  t.true(result.text.includes('Full shell output saved to'));
  t.true(
    result.text.includes(
      'Search that file for what you need instead of rerunning the command or changing the filter criteria with a `| grep` pipeline.',
    ),
  );
  t.false(result.text.includes('FULL-ONLY-SENTINEL'));

  const artifactPath = result.artifactPath as string;
  const artifactContents = fs.readFileSync(artifactPath, 'utf8');

  t.true(artifactContents.includes('Command: demo --long-output'));
  t.true(artifactContents.includes('Working directory: /workspace'));
  t.true(artifactContents.includes('STDOUT:'));
  t.true(artifactContents.includes('STDERR:'));
  t.true(artifactContents.includes('FULL-ONLY-SENTINEL'));

  t.teardown(() => fs.rmSync(path.dirname(artifactPath), { recursive: true, force: true }));
});

test('formatShellExecutionOutput leaves short output unchanged', async (t) => {
  const result = await formatShellExecutionOutput({
    command: 'printf hello',
    cwd: '/workspace',
    stdout: 'hello',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    maxOutputLength: 1000,
  });

  t.false(result.truncated);
  t.is(result.artifactPath, undefined);
  t.false(result.text.includes('Full shell output saved to'));
  t.is(result.text, 'exit 0\nhello');
});
