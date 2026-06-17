import { it, expect } from 'vitest';
import { buildEnvOverrides, isTestEnvironment, parseBooleanEnv } from './settings-env.js';

it('parseBooleanEnv: supports 1/true/yes (case-insensitive)', () => {
  expect(parseBooleanEnv('1')).toBe(true);
  expect(parseBooleanEnv('TRUE')).toBe(true);
  expect(parseBooleanEnv(' yes ')).toBe(true);
  expect(parseBooleanEnv('0')).toBe(false);
  expect(parseBooleanEnv(undefined)).toBe(false);
});

it('buildEnvOverrides: maps TAVILY_API_KEY and WEB_SEARCH_PROVIDER', () => {
  const prev = { ...process.env };
  process.env.TAVILY_API_KEY = 'k';
  process.env.WEB_SEARCH_PROVIDER = 'tavily';

  try {
    const env = buildEnvOverrides();
    expect((env as any).webSearch?.provider).toBe('tavily');
    expect((env as any).webSearch?.tavily?.apiKey).toBe('k');
  } finally {
    process.env = prev;
  }
});

it('isTestEnvironment: true when TERM2_TEST_MODE is set', () => {
  const prev = process.env.TERM2_TEST_MODE;
  process.env.TERM2_TEST_MODE = 'true';

  try {
    expect(isTestEnvironment()).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.TERM2_TEST_MODE;
    else process.env.TERM2_TEST_MODE = prev;
  }
});
