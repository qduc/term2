import { defineConfig, type UserConfig } from 'vitest/config';
import guards from './vitest.config.js';
import integration from './vitest.integration.config.js';
import e2e from './vitest.e2e.config.js';
import provider from './vitest.provider-black-box.config.js';

const configs: Record<string, UserConfig> = { guards, integration, e2e, provider };
const plan: { tier: string; files: string[] }[] = JSON.parse(process.env.TERM2_CI_PLAN!);

// One queue per runner. Retain each tier's setup, deadlines and file isolation.
// Override include explicitly: Vite's extends merge concatenates include arrays,
// which would run each complete tier instead of the assigned inventory.
export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: plan
      .filter(({ files }) => files.length)
      .map(({ tier, files }) => ({
        ...configs[tier],
        test: { ...configs[tier].test, name: tier, include: files },
      })),
  },
});
