import { afterEach, it } from 'vitest';
import { runDiscordDrainTest, READINESS_MS, type Boundary } from './discord-drain-helper.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(['get-release', 'get-timeout', 'post-ack', 'post-timeout'] as const)(
  'built Discord CLI drains %s on SIGINT before releasing ownership and exiting',
  async (boundary: Boundary) => {
    await runDiscordDrainTest('SIGINT', boundary, cleanup);
  },
  5 * READINESS_MS,
);
