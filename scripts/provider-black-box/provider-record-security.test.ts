import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const recorderPath = fileURLToPath(new URL('../provider-record.ts', import.meta.url));

describe('provider recorder credential isolation', () => {
  it('refuses an Anthropic credential for the OpenCode provider', () => {
    const env = { ...process.env };
    delete env.OPENCODE_API_KEY;
    delete env.TERM2_RECORDING_TRANSPORT;
    env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
    env.OPENCODE_BASE_URL = 'http://127.0.0.1:1/v1';

    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        recorderPath,
        '--yes',
        '--provider',
        'opencode',
        '--model',
        'qwen-fixture',
        '--probe',
        'tool-continuation-v1',
      ],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('Missing credentials for opencode (OPENCODE_API_KEY).');
  });
});
