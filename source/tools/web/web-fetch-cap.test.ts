import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebFetchToolDefinition } from './web-fetch.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

// The tool imports @qduc/web-fetch lazily; stub it so the size boundary is
// tested without a network round trip.
const BIG = 'x'.repeat(200_000);
vi.mock('@qduc/web-fetch', () => ({
  fetchWebPage: async () => ({ markdown: BIG, title: 't', url: 'https://example.test' }),
}));

describe('web_fetch result cap', () => {
  const make = () =>
    createWebFetchToolDefinition({
      settingsService: createMockSettingsService(),
      loggingService: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        security: vi.fn(),
      } as unknown as ILoggingService,
    }) as any;

  it('truncates for the model but hands a script the larger payload', async () => {
    const direct = String(await make().execute({ url: 'https://example.test', max_chars: 200_000 }, {}));
    const scripted = String(
      await make().execute({ url: 'https://example.test', max_chars: 200_000 }, { scripted: true }),
    );

    // web_* is script-only, so a truncated page inside a script has no direct
    // fallback the model would notice.
    expect(direct.length).toBeLessThan(41_000);
    expect(direct).toContain('Full output saved to');
    expect(scripted.length).toBeGreaterThan(90_000);
  });
});
