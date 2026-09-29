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
    expect(env.webSearch?.provider).toBe('tavily');
    expect(env.webSearch?.tavily?.apiKey).toBe('k');
  } finally {
    process.env = prev;
  }
});

it('buildEnvOverrides: omits unset sibling credentials and URLs', () => {
  const prev = { ...process.env };
  delete process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_BASE_URL = 'http://localhost:3002';
  delete process.env.SEARXNG_BASE_URL;
  delete process.env.TAVILY_API_KEY;
  delete process.env.EXA_API_KEY;

  try {
    const env = buildEnvOverrides();
    expect(env.webSearch?.firecrawl).toEqual({ baseUrl: 'http://localhost:3002' });
    expect(env.webSearch?.firecrawl).not.toHaveProperty('apiKey');
    expect(env.webSearch?.searxng).toBeUndefined();
    expect(env.webSearch?.tavily).toBeUndefined();
    expect(env.webSearch?.exa).toBeUndefined();
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
