import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser flows for the web client: `pnpm test:web-browser`, after `pnpm build` and
// `node scripts/build-web.mjs`. They drive the built `term2-web` in Chromium against a loopback model
// double (see launch.ts), so this is its own tier and its own CI lane; Vitest never collects `*.flow.ts`.
//
// Failure evidence (screenshots, the product's output) must not land in the repository tree. Workers
// load this file again and inherit the environment, so the directory is chosen once per run.
process.env.TERM2_WEB_FLOW_OUTPUT ??= fs.mkdtempSync(path.join(os.tmpdir(), 'term2-web-flows-'));

export default defineConfig({
  testDir: '.',
  testMatch: '*.flow.ts',
  outputDir: process.env.TERM2_WEB_FLOW_OUTPUT,
  // Each flow launches its own gateway, web server and model double, so flows can run side by side.
  fullyParallel: true,
  // Flows mostly wait on their servers: on the 4-vCPU CI runner two workers (Playwright's default there) used
  // 133-144% CPU, and the lane reached its 120 s budget. Three took the suite from 82 s to 60-65 s locally with
  // 102 flow runs passing; four (54 s) let the concise tool-row flow miss a transient label under load.
  workers: process.env.CI ? 3 : undefined,
  forbidOnly: Boolean(process.env.CI),
  // A flow that passes only on a second attempt is a finding, not a pass.
  retries: 0,
  reporter: [['list'], ['./remove-empty-output.ts']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    ...devices['Desktop Chrome'],
    // Screenshots are evidence someone compares by eye; keep one CSS pixel per image pixel.
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
});
