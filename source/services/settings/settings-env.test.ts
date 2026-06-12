import test from 'ava';
import { buildEnvOverrides, isTestEnvironment, parseBooleanEnv } from './settings-env.js';

test('parseBooleanEnv: supports 1/true/yes (case-insensitive)', (t) => {
  t.true(parseBooleanEnv('1'));
  t.true(parseBooleanEnv('TRUE'));
  t.true(parseBooleanEnv(' yes '));
  t.false(parseBooleanEnv('0'));
  t.false(parseBooleanEnv(undefined));
});

test('buildEnvOverrides: maps TAVILY_API_KEY and WEB_SEARCH_PROVIDER', (t) => {
  const prev = { ...process.env };
  process.env.TAVILY_API_KEY = 'k';
  process.env.WEB_SEARCH_PROVIDER = 'tavily';

  t.teardown(() => {
    process.env = prev;
  });

  const env = buildEnvOverrides();
  t.is((env as any).webSearch?.provider, 'tavily');
  t.is((env as any).webSearch?.tavily?.apiKey, 'k');
});

test('isTestEnvironment: true when TERM2_TEST_MODE is set', (t) => {
  const prev = process.env.TERM2_TEST_MODE;
  process.env.TERM2_TEST_MODE = 'true';
  t.teardown(() => {
    if (prev === undefined) delete process.env.TERM2_TEST_MODE;
    else process.env.TERM2_TEST_MODE = prev;
  });

  t.true(isTestEnvironment());
});
