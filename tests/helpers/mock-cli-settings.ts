import fs from 'node:fs';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

/** Startup-only controls must not inherit the real default provider, even on an early exit. */
export function writeMockCliSettings(homeDir: string, env: NodeJS.ProcessEnv = {}): void {
  const directory = resolveSettingsDirectory({ homeDir, env });
  fs.mkdirSync(directory, { recursive: true });
  // Closed loopback endpoint: an unexpected turn fails locally rather than using a live provider.
  fs.writeFileSync(
    path.join(directory, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { provider: 'mockprov', model: 'mock-alpha' } },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key' },
      ],
    }),
    { flag: 'wx' },
  );
}
