import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  HARNESS_IDLE_ENV,
  publishHarnessInputState,
  readHarnessIdleGeneration,
  resetHarnessInputIdleForTests,
  waitForHarnessIdleGeneration,
} from './harness-input-idle.js';

const original = process.env[HARNESS_IDLE_ENV];

afterEach(() => {
  resetHarnessInputIdleForTests();
  if (original === undefined) delete process.env[HARNESS_IDLE_ENV];
  else process.env[HARNESS_IDLE_ENV] = original;
});

async function idlePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'term2-harness-idle-'));
  const path = join(dir, 'input-idle');
  process.env[HARNESS_IDLE_ENV] = path;
  return path;
}

it('does not write when the harness env is unset', async () => {
  delete process.env[HARNESS_IDLE_ENV];
  const path = join(tmpdir(), 'term2-harness-idle-missing', 'input-idle');
  publishHarnessInputState({ owner: 'input', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(0);
});

it('creates the idle-path parent directory when it is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'term2-harness-idle-'));
  const path = join(dir, 'missing-parent', 'input-idle');
  process.env[HARNESS_IDLE_ENV] = path;
  publishHarnessInputState({ owner: 'input', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(1);
});

it('writes generation 1 when the composer first becomes idle', async () => {
  const path = await idlePath();
  publishHarnessInputState({ owner: 'input', processing: false });
  expect(await readFile(path, 'utf8')).toBe('1\n');
  expect(readHarnessIdleGeneration(path)).toBe(1);
});

it('does not increment while the composer stays idle', async () => {
  const path = await idlePath();
  publishHarnessInputState({ owner: 'input', processing: false });
  publishHarnessInputState({ owner: 'input', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(1);
});

it('increments only on a return to idle after a busy owner', async () => {
  const path = await idlePath();
  publishHarnessInputState({ owner: 'input', processing: false });
  publishHarnessInputState({ owner: 'input', processing: true });
  publishHarnessInputState({ owner: 'approval', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(1);
  publishHarnessInputState({ owner: 'input', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(2);
});

it('does not treat first-run or menu ownership as idle', async () => {
  const path = await idlePath();
  publishHarnessInputState({ owner: 'first-run-setup', processing: false });
  publishHarnessInputState({ owner: 'menu', processing: false });
  expect(readHarnessIdleGeneration(path)).toBe(0);
});

it('waitForHarnessIdleGeneration resolves once the generation advances', async () => {
  const path = await idlePath();
  const pending = waitForHarnessIdleGeneration(path, { after: 0, timeoutMs: 1_000 });
  publishHarnessInputState({ owner: 'input', processing: false });
  await expect(pending).resolves.toBe(1);
});

it('waitForHarnessIdleGeneration times out when the generation never advances', async () => {
  const path = await idlePath();
  await expect(waitForHarnessIdleGeneration(path, { after: 0, timeoutMs: 30 })).rejects.toThrow(/idle generation > 0/i);
});

it('waitForHarnessIdleGeneration names the effective ceiling in its timeout error', async () => {
  const path = await idlePath();
  await expect(waitForHarnessIdleGeneration(path, { after: 0, timeoutMs: 30 })).rejects.toThrow(/after 30ms/i);
});
