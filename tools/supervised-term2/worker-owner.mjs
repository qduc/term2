import { processIdentity, DEFAULT_MAX_HANDOFF_BYTES } from './supervisor.mjs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setInterval } from 'node:timers';
import { readFile } from 'node:fs';
import { promisify } from 'node:util';

const owner = JSON.parse(process.env.TERM2_SUPERVISOR_OWNER ?? 'null');
if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.identity !== 'string') {
  throw new Error('Supervised worker requires a verified owner identity');
}
let checking = false;
const verifyOwner = async () => {
  if (checking) return;
  checking = true;
  try {
    if ((await processIdentity(owner.pid)) !== owner.identity) throw new Error('Owner identity changed');
  } catch {
    // This process is the leader of its dedicated group. No unrelated processes
    // are signalled. A SIGKILLed supervisor leaves its lock for explicit recovery.
    process.kill(-process.pid, 'SIGKILL');
  } finally {
    checking = false;
  }
};
await verifyOwner();
setInterval(() => {
  void verifyOwner();
}, 250).unref();
const handoff = await promisify(readFile)(3, 'utf8');
if (Buffer.byteLength(handoff) > DEFAULT_MAX_HANDOFF_BYTES) throw new Error('Supervised handoff exceeds byte ceiling');
process.argv.push(handoff);
