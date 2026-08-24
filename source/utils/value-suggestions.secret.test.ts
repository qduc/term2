import { describe, expect, it } from 'vitest';
import { isSecretSetting } from './value-suggestions.js';

describe('isSecretSetting', () => {
  it('marks provider API keys as secret', () => {
    expect(isSecretSetting('agent.openrouter.apiKey')).toBe(true);
    expect(isSecretSetting('agent.openai.apiKey')).toBe(true);
    expect(isSecretSetting('apiKey')).toBe(true);
  });

  it('leaves non-credential settings alone', () => {
    expect(isSecretSetting('agent.openrouter.baseUrl')).toBe(false);
    expect(isSecretSetting('agent.model')).toBe(false);
    expect(isSecretSetting('agent.apiKeyLabel')).toBe(false);
  });
});
