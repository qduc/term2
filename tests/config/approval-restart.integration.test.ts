import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRestartPlan } from '../../src/shared/utils/process-restart.js';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';

const envModule = new URL('../../src/config/settings/settings-env.ts', import.meta.url).href;
const serviceModule = new URL('../../src/app/settings-service.ts', import.meta.url).href;
const childScript = `
  import { buildEnvOverrides } from ${JSON.stringify(envModule)};
  import { SettingsService } from ${JSON.stringify(serviceModule)};
  const options = {settingsDir: process.env.APPROVAL_FIXTURE_DIR, disableLogging: true, disableFilePersistence: true};
  const snapshot = settings => Object.fromEntries(['shell.autoApproveMode', 'shell.showReview', 'sandbox.enabled'].map(key => [key, {value:settings.getDynamic(key),source:settings.getSource(key)}]));
  const inherited = new SettingsService({...options,env:buildEnvOverrides()});
  const cli = new SettingsService({...options,env:buildEnvOverrides(),cli:{shell:{autoApproveMode:'auto',showReview:!inherited.get('shell.showReview')},sandbox:{enabled:!inherited.get('sandbox.enabled')}}});
  const errors = {};
  for (const mode of ['advisory','invalid']) {
    process.env.SHELL_AUTO_APPROVE_MODE = mode;
    try { buildEnvOverrides(); errors[mode] = null; } catch (error) { errors[mode] = error.message; }
  }
  process.env.SHELL_AUTO_APPROVE_MODE = 'auto';
  for (const [key, bad] of [['SANDBOX_ENABLED', ''], ['SANDBOX_ENABLED', 'ture'], ['TERM2_SHOW_REVIEW', 'maybe']]) {
    const prev = process.env[key];
    process.env[key] = bad;
    try { buildEnvOverrides(); errors[key + ':' + bad] = null; } catch (error) { errors[key + ':' + bad] = error.message; }
    process.env[key] = prev;
  }
  console.log(JSON.stringify({inherited:snapshot(inherited),cli:snapshot(cli),errors}));
`;

it.each([
  ['off', false, true],
  ['auto', true, false],
  ['unattended', false, false],
  ['always', true, true],
] as const)(
  'consumes restarted %s policy above saved preferences while keeping CLI precedence',
  async (approval, sandbox, showReview) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-restart-policy-'));
    try {
      const settingsFile = path.join(root, 'settings.json');
      const saved = JSON.stringify({
        shell: { autoApproveMode: approval === 'off' ? 'always' : 'off', showReview: !showReview },
        sandbox: { enabled: !sandbox },
      });
      await fs.writeFile(settingsFile, saved);
      const plan = createRestartPlan({
        entry: 'unused-cli.js',
        sessionId: 'leaf',
        model: {},
        profile: 'builtin:bare',
        approval,
        sandbox,
        showReview,
      });
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript],
        {
          env: createTestChildEnv({
            APPROVAL_FIXTURE_DIR: root,
            SHELL_AUTO_APPROVE_MODE: plan.env.SHELL_AUTO_APPROVE_MODE,
            SANDBOX_ENABLED: plan.env.SANDBOX_ENABLED,
            TERM2_SHOW_REVIEW: plan.env.TERM2_SHOW_REVIEW,
            DISABLE_LOGGING: '1',
          }),
        },
      );
      const result = JSON.parse(stdout);
      expect(result.inherited).toEqual({
        'shell.autoApproveMode': { value: approval, source: 'env' },
        'shell.showReview': { value: showReview, source: 'env' },
        'sandbox.enabled': { value: sandbox, source: 'env' },
      });
      expect(result.cli).toEqual({
        'shell.autoApproveMode': { value: 'auto', source: 'cli' },
        'shell.showReview': { value: !showReview, source: 'cli' },
        'sandbox.enabled': { value: !sandbox, source: 'cli' },
      });
      expect(result.errors.advisory).toContain('use off with shell.showReview=true');
      expect(result.errors.invalid).toContain('Invalid SHELL_AUTO_APPROVE_MODE');
      expect(result.errors['SANDBOX_ENABLED:']).toContain('Invalid SANDBOX_ENABLED');
      expect(result.errors['SANDBOX_ENABLED:ture']).toContain('Invalid SANDBOX_ENABLED');
      expect(result.errors['TERM2_SHOW_REVIEW:maybe']).toContain('Invalid TERM2_SHOW_REVIEW');
      expect(await fs.readFile(settingsFile, 'utf8')).toBe(saved);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
