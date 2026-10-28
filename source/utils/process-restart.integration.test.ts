import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createRestartPlan } from './process-restart.js';

it('executes shell-quoted manual recovery with exactly the current resume/settings/SSH/control context', async () => {
  const root = await mkdtemp(join(tmpdir(), "term2-restart-quote-'"));
  try {
    await mkdir(join(root, 'dist'));
    const entry = join(root, 'dist/cli.js');
    await writeFile(
      entry,
      `console.log(JSON.stringify({argv:process.argv.slice(2),approval:process.env.SHELL_AUTO_APPROVE_MODE,sandbox:process.env.SANDBOX_ENABLED,herdr:process.env.HERDR_PANE_ID}));`,
    );
    const plan = createRestartPlan({
      entry,
      sessionId: 'latest-empty-leaf',
      model: { model: "fixture's model", provider: 'fixture-provider' },
      reasoning: 'high',
      profile: 'builtin:bare',
      approval: 'advisory',
      sandbox: false,
      ssh: { target: 'user@host', directory: "/remote/it's here", port: 2222 },
      control: { name: 'connected-now', discordInput: false },
    });
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', plan.manualCommand], {
      env: {
        ...process.env,
        HERDR_PANE_ID: 'fixture-pane',
        SHELL_AUTO_APPROVE_MODE: 'always',
        SANDBOX_ENABLED: 'true',
      },
    });
    const captured = JSON.parse(stdout);
    expect(captured).toEqual({
      argv: plan.args.slice(1),
      approval: 'advisory',
      sandbox: 'false',
      herdr: 'fixture-pane',
    });
    expect(captured.argv).toEqual([
      '--resume',
      'latest-empty-leaf',
      '--model',
      "fixture's model",
      '--provider',
      'fixture-provider',
      '--reasoning',
      'high',
      '--profile',
      'builtin:bare',
      '--ssh',
      'user@host',
      '--ssh-port',
      '2222',
      '--remote-dir',
      "/remote/it's here",
      '--control-socket=connected-now',
    ]);
    expect(plan.env.SHELL_AUTO_APPROVE_MODE).toBe('advisory');
    expect(plan.env.SANDBOX_ENABLED).toBe('false');
    expect(
      createRestartPlan({
        entry,
        sessionId: 'leaf',
        model: {},
        profile: 'builtin:bare',
        approval: 'off',
        sandbox: true,
        control: { name: 'opted-in', discordInput: true },
      }).args,
    ).toContain('--discord-input');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
