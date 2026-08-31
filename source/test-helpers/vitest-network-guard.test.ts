import { expect, it } from 'vitest';

it('rejects external HTTP requests before a socket is opened', async () => {
  await expect(fetch('https://openrouter.ai/api/v1/models')).rejects.toThrow(
    'External network access is disabled in tests',
  );
});
