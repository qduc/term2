/**
 * Test fixture for the PTY-child reaper. Starts one PTY child through a real
 * isolated lease, publishes its pid, and then idles without ever cleaning up.
 *
 * The reaper regression test signals this process and asserts the PTY child
 * dies with it. It has to be a separate process because the behavior under
 * test is process teardown.
 */
import { writeFile } from 'node:fs/promises';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

const childScript = process.argv[2];
const pidPath = process.argv[3];
if (!childScript || !pidPath) throw new Error('usage: provider-reaper-owner.ts <child-script> <pid-path>');

const workspace = await createIsolatedWorkspaceLease();
const child = await workspace.start({ command: process.execPath, args: [childScript, 'hang'] });
await child.waitForVisibleOutput('hanging', 10_000);

await writeFile(pidPath, `${child.pid}\n`, 'utf8');
process.stdout.write('owner ready\n');

// Deliberately no cleanup: an interrupted run never reaches afterEach either.
await new Promise(() => setInterval(() => undefined, 1_000));
