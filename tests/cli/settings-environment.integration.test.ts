import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  writeWorldSettings,
} from '../helpers/loopback-chat-world.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { SETTING_ENV_VARIABLES } from '../../src/config/settings/settings-env.js';
import {
  startFakeProviderHttpServer,
  type FakeProviderHttpServer,
} from '../../scripts/provider-black-box/fake-provider-http-server.js';

// Environment variables that override a setting (SETTING_ENV_VARIABLES, src/config/settings/settings-env.ts),
// through the built CLI. For each variable the table runs the setting as settings.json alone gives it, the
// variable alone, and both together: the variable must change what the run does and beat settings.json.
// The code's precedence is defaults < settings.json < environment < command line, except for the API keys in
// ENV_FALLBACK_CREDENTIAL_KEYS, where a non-empty key in settings.json wins and the variable is a fallback
// (tests/cli/api-key-environment.integration.test.ts).
//
// No command prints the effective settings outside the interactive UI, and the UI's settings menu hides several
// of these keys, so each setting is observed through what it controls, in one headless run per case:
//   OpenRouter base URL, referrer, title   which loopback server gets the model request, and the headers it carries
//   log level, disable logging             whether the run writes a log file, and whether it holds debug entries
//   log file operations                    whether create_file writes its "File operation started" debug entry
//
// Every entry of SETTING_ENV_VARIABLES is in exactly one of three places, and the last test fails for an entry that
// is in none: the table (ROWS), a test elsewhere that names the variable (ASSERTED_ELSEWHERE), or the entries no
// cheap check reaches (NOT_OBSERVED).

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

type Value = string | boolean | undefined;

// ---------------------------------------------------------------------------------------------------------------
// Observations

/** `{ [name]: value }`, or nothing when the case leaves it unset. */
const set = (name: string, value: Value): Record<string, string> =>
  value === undefined ? {} : { [name]: String(value) };
const urlOf = (server: FakeProviderHttpServer) => `${server.baseUrl}/api/v1`;
const header = (request: { headers: Record<string, string | string[] | undefined> } | undefined, name: string) => {
  const value = request?.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

/**
 * One headless run through the OpenRouter provider against two loopback servers, `a` and `b`. `build` gets their
 * URLs and returns what goes under agent.openrouter in settings.json and into the child's environment.
 */
async function openRouterRun(
  build: (urls: { a: string; b: string }) => { settings: Record<string, string>; env: Record<string, string> },
) {
  const world = createWorld('term2-env-openrouter');
  const a = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
  const b = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
  try {
    const { settings, env } = build({ a: urlOf(a), b: urlOf(b) });
    writeWorldSettings(world, 'http://127.0.0.1:1/v1', {
      sandbox: { enabled: false },
      agent: { openrouter: { apiKey: 'settings-key', ...settings } },
    });
    const result = await runCli({ ...world, env: { ...world.env, ...env } }, integrationCliPath(), [
      '--profile',
      'bare',
      '--provider',
      'openrouter',
      '--model',
      'fixture/model',
      'Say hello',
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const post = (server: FakeProviderHttpServer) => server.requests.find((request) => request.method === 'POST');
    return {
      /** Which servers got the model request: `a`, `b`, `ab` or an empty string. */
      reached: `${post(a) ? 'a' : ''}${post(b) ? 'b' : ''}`,
      request: post(a) ?? post(b),
    };
  } finally {
    removeWorld(world);
    await Promise.all([a.close(), b.close()]);
  }
}

/** One headless run in which the model creates a file, with logging on unless the case turns it off. */
async function loggedRun(options: { settings: Record<string, unknown>; env: Record<string, string> }) {
  const world = createWorld('term2-env-logging');
  const provider = await startLoopbackProvider({
    turns: [{ call: { tool: 'create_file', args: { path: 'created.txt', content: 'hello' } } }],
  });
  try {
    writeWorldSettings(world, provider.baseUrl, {
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'always' },
      ...options.settings,
    });
    // The isolated world turns logging off for every test; a logging case starts from logging on.
    const { DISABLE_LOGGING: _logging, ...env } = world.env;
    const result = await runCli({ ...world, env: { ...env, ...options.env } }, integrationCliPath(), [
      '--profile',
      'bare',
      'Create the file',
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(world.workspace, 'created.txt'), 'utf8')).toBe('hello');
    const directory = path.join(resolveSettingsDirectory({ homeDir: world.home, env: world.env }), 'logs');
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.log')) : [];
    const text = files.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
    return {
      wroteLogFile: files.length > 0,
      wroteDebugEntries: text.includes('"level":"debug"'),
      wroteFileOperationEntry: text.includes('File operation started: create_file'),
    };
  } finally {
    await provider.close();
    removeWorld(world);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The table: [value in settings.json, value of the variable, what the run shows]

type Row = {
  readonly key: string;
  readonly variable: string;
  readonly observe: (settings: Value, env: Value) => Promise<unknown>;
  readonly cases: ReadonlyArray<readonly [settings: Value, env: Value, observed: unknown]>;
};

const REFERRER_DEFAULT = 'https://github.com/qduc/term2';
const REFERRER = ['https://settings.example/referrer', 'https://env.example/referrer'] as const;
const TITLE = ['settings title', 'env title'] as const;

const ROWS: readonly Row[] = [
  {
    key: 'agent.openrouter.baseUrl',
    variable: 'OPENROUTER_BASE_URL',
    // The values name a server: `a` for settings.json, `b` for the variable.
    observe: async (settings, env) =>
      (
        await openRouterRun((urls) => ({
          settings: set('baseUrl', settings === undefined ? undefined : urls[settings as 'a' | 'b']),
          env: set('OPENROUTER_BASE_URL', env === undefined ? undefined : urls[env as 'a' | 'b']),
        }))
      ).reached,
    cases: [
      ['a', undefined, 'a'],
      [undefined, 'b', 'b'],
      ['a', 'b', 'b'],
    ],
  },
  {
    key: 'agent.openrouter.referrer',
    variable: 'OPENROUTER_REFERRER',
    observe: async (settings, env) => {
      const { request } = await openRouterRun((urls) => ({
        settings: { baseUrl: urls.a, ...set('referrer', settings) },
        env: set('OPENROUTER_REFERRER', env),
      }));
      return header(request, 'http-referer');
    },
    cases: [
      [undefined, undefined, REFERRER_DEFAULT],
      [REFERRER[0], undefined, REFERRER[0]],
      [undefined, REFERRER[1], REFERRER[1]],
      [REFERRER[0], REFERRER[1], REFERRER[1]],
    ],
  },
  {
    key: 'agent.openrouter.title',
    variable: 'OPENROUTER_TITLE',
    observe: async (settings, env) => {
      const { request } = await openRouterRun((urls) => ({
        settings: { baseUrl: urls.a, ...set('title', settings) },
        env: set('OPENROUTER_TITLE', env),
      }));
      // Sent under two names; both carry the title.
      return `${header(request, 'x-title')} / ${header(request, 'x-openrouter-title')}`;
    },
    cases: [
      [undefined, undefined, 'term2 / term2'],
      [TITLE[0], undefined, `${TITLE[0]} / ${TITLE[0]}`],
      [undefined, TITLE[1], `${TITLE[1]} / ${TITLE[1]}`],
      [TITLE[0], TITLE[1], `${TITLE[1]} / ${TITLE[1]}`],
    ],
  },
  {
    key: 'logging.logLevel',
    variable: 'LOG_LEVEL',
    // Whether the run logged at debug level.
    observe: async (settings, env) =>
      (
        await loggedRun({
          settings: settings === undefined ? {} : { logging: { logLevel: settings } },
          env: set('LOG_LEVEL', env),
        })
      ).wroteDebugEntries,
    cases: [
      ['error', undefined, false],
      ['debug', undefined, true],
      [undefined, 'debug', true],
      ['error', 'debug', true],
      ['debug', 'error', false],
    ],
  },
  {
    key: 'logging.disableLogging',
    variable: 'DISABLE_LOGGING',
    // Whether the run wrote a log file at all.
    observe: async (settings, env) =>
      (
        await loggedRun({
          settings: settings === undefined ? {} : { logging: { disableLogging: settings } },
          env: set('DISABLE_LOGGING', env),
        })
      ).wroteLogFile,
    cases: [
      [false, undefined, true],
      [true, undefined, false],
      [undefined, 'true', false],
      [false, 'true', false],
      [true, 'false', true],
      [false, '1', false],
      [true, '0', true],
      [true, 'no', true],
      [false, 'yes', false],
    ],
  },
  {
    key: 'tools.logFileOperations',
    variable: 'LOG_FILE_OPERATIONS',
    // Whether create_file logged that it started. The entry is a debug entry, so the level is fixed at debug.
    observe: async (settings, env) =>
      (
        await loggedRun({
          settings: {
            logging: { logLevel: 'debug' },
            ...(settings === undefined ? {} : { tools: { logFileOperations: settings } }),
          },
          env: set('LOG_FILE_OPERATIONS', env),
        })
      ).wroteFileOperationEntry,
    cases: [
      [true, undefined, true],
      [false, undefined, false],
      [undefined, 'false', false],
      [true, 'false', false],
      [false, 'true', true],
      [false, '1', true],
      [true, '0', false],
      [true, 'no', false],
      [false, 'yes', true],
    ],
  },
];

/** Entries whose variable another test asserts: the test file must name the variable. */
const OTHER_TESTS = {
  approval: 'tests/config/approval-restart.integration.test.ts',
  keys: 'tests/cli/api-key-environment.integration.test.ts',
} as const;
const ASSERTED_ELSEWHERE: Readonly<Record<string, { variable: string; file: string }>> = {
  'shell.showReview': { variable: 'TERM2_SHOW_REVIEW', file: OTHER_TESTS.approval },
  'shell.autoApproveMode': { variable: 'SHELL_AUTO_APPROVE_MODE', file: OTHER_TESTS.approval },
  'sandbox.enabled': { variable: 'SANDBOX_ENABLED', file: OTHER_TESTS.approval },
  'agent.openrouter.apiKey': { variable: 'OPENROUTER_API_KEY', file: OTHER_TESTS.keys },
  'agent.openai.apiKey': { variable: 'OPENAI_API_KEY', file: OTHER_TESTS.keys },
  'webSearch.tavily.apiKey': { variable: 'TAVILY_API_KEY', file: OTHER_TESTS.keys },
  'webSearch.exa.apiKey': { variable: 'EXA_API_KEY', file: OTHER_TESTS.keys },
  'webSearch.firecrawl.apiKey': { variable: 'FIRECRAWL_API_KEY', file: OTHER_TESTS.keys },
  'webSearch.firecrawl.baseUrl': { variable: 'FIRECRAWL_BASE_URL', file: OTHER_TESTS.keys },
  'webSearch.searxng.baseUrl': { variable: 'SEARXNG_BASE_URL', file: OTHER_TESTS.keys },
  'webSearch.provider': { variable: 'WEB_SEARCH_PROVIDER', file: OTHER_TESTS.keys },
};

/** Entries with no check here, and why. */
const NOT_OBSERVED: Readonly<Record<string, { variable: string; reason: string }>> = {
  'logging.debugLogging': {
    variable: 'DEBUG_LOGGING',
    reason:
      'only lets the logger print its own failures (such as a log directory it cannot create) to stderr, and only when ' +
      'logging.suppressConsoleOutput is off; making the CLI fail that way costs more than the entry is worth',
  },
  'debug.debugBashTool': {
    variable: 'DEBUG_BASH_TOOL',
    reason:
      'only prints `[BASH_TOOL_ERROR]` to stderr when the shell tool throws while deciding on approval, which a ' +
      'model call cannot be made to do, and only when logging.suppressConsoleOutput is off',
  },
};

// ---------------------------------------------------------------------------------------------------------------

const describeValue = (value: Value) => (value === undefined ? 'unset' : JSON.stringify(value));

describe.concurrent('an environment variable overrides settings.json', () => {
  for (const row of ROWS) {
    for (const [settings, env, observed] of row.cases) {
      it(
        `${row.variable} -> ${row.key}: settings.json ${describeValue(settings)}, variable ${describeValue(env)}`,
        { timeout: 30_000 },
        async () => {
          expect(await row.observe(settings, env)).toEqual(observed);
        },
      );
    }
  }
});

describe('every entry of SETTING_ENV_VARIABLES is covered', () => {
  const inTable = ROWS.map((row) => row.key);
  const elsewhere = Object.keys(ASSERTED_ELSEWHERE);
  const unobserved = Object.keys(NOT_OBSERVED);

  it('is in exactly one of the table, the tests that name its variable, and the list of unobserved entries', () => {
    const accounted = [...inTable, ...elsewhere, ...unobserved];
    const known = Object.keys(SETTING_ENV_VARIABLES);
    // A new entry has to be added to one of the three places; an entry that is gone has to be taken out.
    expect(
      known.filter((key) => !accounted.includes(key)),
      'in SETTING_ENV_VARIABLES, but in no list here',
    ).toEqual([]);
    expect(
      accounted.filter((key) => !known.includes(key)),
      'listed here, but not in SETTING_ENV_VARIABLES',
    ).toEqual([]);
    expect(
      accounted.filter((key, index) => accounted.indexOf(key) !== index),
      'listed more than once',
    ).toEqual([]);
  });

  it('names the variable the code maps each entry to', () => {
    for (const row of ROWS) expect(SETTING_ENV_VARIABLES[row.key], row.key).toBe(row.variable);
    for (const [key, entry] of Object.entries({ ...ASSERTED_ELSEWHERE, ...NOT_OBSERVED })) {
      expect(SETTING_ENV_VARIABLES[key], key).toBe(entry.variable);
    }
  });

  it('keeps the tests that are said to assert a variable naming it', () => {
    for (const [key, { variable, file }] of Object.entries(ASSERTED_ELSEWHERE)) {
      const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
      expect(source, `${file} no longer names ${variable} (${key})`).toContain(variable);
    }
  });
});
