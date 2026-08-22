import { expect, it, vi } from 'vitest';
import { killAllShellChildrenAtProcessExit, ShellChildRegistry } from './shell-child-registry.js';

const child = () => ({ kill: vi.fn(), pid: undefined } as never);

it('kills only the disposing session children while process cleanup retains the union', () => {
  const sessionA = new ShellChildRegistry();
  const sessionB = new ShellChildRegistry();
  const childA = child() as { kill: ReturnType<typeof vi.fn> };
  const childB = child() as { kill: ReturnType<typeof vi.fn> };

  sessionA.add(childA as never);
  sessionB.add(childB as never);
  sessionA.killAll();

  expect(childA.kill).toHaveBeenCalledWith('SIGKILL');
  expect(childB.kill).not.toHaveBeenCalled();

  killAllShellChildrenAtProcessExit();
  expect(childB.kill).toHaveBeenCalledWith('SIGKILL');
});
