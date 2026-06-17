import { it, expect } from 'vitest';
import './env-setup.js';

it('env-setup disables openai agents tracing globally', () => {
  expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBe('true');
});
