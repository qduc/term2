import { relative } from 'node:path';
import { defineConfig, type UserConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import guards from './vitest.config.js';
import integration from './vitest.integration.config.js';
import e2e from './vitest.e2e.config.js';
import provider from './vitest.provider-black-box.config.js';

const configs: Record<string, UserConfig> = { guards, integration, e2e, provider };
const plan: { tier: string; files: string[] }[] = JSON.parse(process.env.TERM2_CI_PLAN!);

// Project values override the root one, and Vitest rejects projects in one
// queue that disagree, so every project gets the CI value explicitly.
const maxWorkers = Number(process.env.TERM2_CI_MAX_WORKERS);
if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error('Expected a positive CI worker count');

// Vitest's default order runs projects by name before duration, so a long file in a later
// project (provider-session-stateless in the integration lane) waited for every earlier file
// and became the lane's tail. Order all files by recorded duration, longest first; files
// without one keep the default order ahead of them. Projects already share the worker pool.
// Durations come from the results cache the setup action restores per lane; the cache
// accessor BaseSequencer itself uses is missing from Vitest's public typings.
class LongestFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const cache = (
      this.ctx as unknown as { cache: { getFileTestResults(key: string): { duration: number } | undefined } }
    ).cache;
    const duration = (file: TestSpecification) =>
      cache.getFileTestResults(`${file.project.name}:${relative(this.ctx.config.root, file.moduleId)}`)?.duration;
    return (await super.sort(files)).sort((a, b) => {
      const [x, y] = [duration(a), duration(b)];
      return x === undefined || y === undefined ? (x === undefined ? 0 : 1) - (y === undefined ? 0 : 1) : y - x;
    });
  }
}

// One queue per runner. Retain each tier's setup, deadlines and file isolation.
// Override include explicitly: Vite's extends merge concatenates include arrays,
// which would run each complete tier instead of the assigned inventory.
export default defineConfig({
  test: {
    maxWorkers,
    sequence: { sequencer: LongestFirstSequencer },
    projects: plan
      .filter(({ files }) => files.length)
      .map(({ tier, files }) => ({
        ...configs[tier],
        test: { ...configs[tier].test, name: tier, include: files, maxWorkers },
      })),
  },
});
