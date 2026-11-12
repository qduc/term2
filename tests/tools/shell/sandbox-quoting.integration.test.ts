import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { AnthropicShellSandboxRunner } from '../../../src/tools/shell/sandbox/shell-sandbox-runner.js';
import { executeShellCommand } from '../../../src/tools/shell/execute-shell.js';

// Exercise the actual wrapper, nested shell parsing and child process. A mock
// wrapper misses shell-quote inserting a backslash inside a double-quoted argv.
describe.skipIf(process.platform !== 'linux')('sandbox command byte preservation', () => {
  const runner = new AnthropicShellSandboxRunner();
  let cwd: string;
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'term2-sandbox-quote-'));
    expect(await runner.availability()).toEqual({ type: 'available' });
  });
  afterEach(() => runner.cleanupAfterCommand());
  afterAll(async () => {
    await SandboxManager.reset();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it.each([
    ['Python inequality', 'python3 -c \'assert 1 != 2; print("ok!")\'', 'ok!'],
    ['Python quoted heredoc', "python3 - <<'PY'\nassert 1 != 2\nprint(f'{7!r}')\nPY", '7'],
    ['JavaScript negation', "node -e 'console.log(!false)'", 'true'],
    ['ordinary command control', 'printf %s ordinary', 'ordinary'],
  ])('preserves %s through the real sandbox', async (_name, command, expected) => {
    const wrapped = await runner.wrap(command, { cwd });
    const result = await executeShellCommand(wrapped.command, { cwd, timeout: 5000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(expected);
  });

  it('keeps quoted metacharacters as literal argument data', async () => {
    const values = ['both\'"quotes!', 'back\\slash!', '$HOME! `literal`', 'line\none!', 'unicode café!'];
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = [
      'node',
      '-e',
      quote('console.log(JSON.stringify(process.argv.slice(1)))'),
      ...values.map(quote),
    ].join(' ');
    const wrapped = await runner.wrap(command, { cwd });
    const result = await executeShellCommand(wrapped.command, { cwd, timeout: 5000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(values);
    expect(result.stderr).toBe('');
  });

  it('preserves genuine interpreter failure instead of replacing it with a syntax error', async () => {
    const wrapped = await runner.wrap("python3 -c 'assert 1 != 1'", { cwd });
    const result = await executeShellCommand(wrapped.command, { cwd, timeout: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('AssertionError');
    expect(result.stderr).not.toContain('SyntaxError');
  });
});
