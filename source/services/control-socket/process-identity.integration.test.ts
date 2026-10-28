import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { readProcStartTime } from './control-socket.js';

it('reads the kernel identity of a live child and stops identifying it after exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    const token = readProcStartTime(child.pid!);
    expect(token).toBeTruthy();
    expect(readProcStartTime(child.pid!)).toBe(token);
    if (process.platform === 'darwin') expect(token).toMatch(/^darwin:\d+:\d+$/);
  } finally {
    child.kill();
    await exited;
  }
  expect(readProcStartTime(child.pid!)).toBeNull();
});
