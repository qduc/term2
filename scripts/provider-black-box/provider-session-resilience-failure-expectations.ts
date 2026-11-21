import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { IsolatedWorkspaceLease } from './provider-test-harness.js';

/**
 * What a user and the conversation log receive when a provider turn fails, per route and scenario,
 * for the one-shot failure scenarios in `provider-session-resilience-scenarios.ts`. Observed against
 * the built CLI with `agent.retryAttempts: 0` (so exactly one provider request and "after 1 attempt"
 * in the notice) and then checked against the code that produces each message:
 *
 * - `src/session/harness-host/index.ts` words the stored notice (`Could not reach ...`,
 *   `... answered with an error after 1 attempt ...`); the headless runner prints `error <message>`.
 * - Incomplete-stream messages come from the adapters: `openai-responses-model.ts`,
 *   `codex-responses-model.ts`, `openai-chat-completions-model.ts`, `ai-sdk-streamed-model.ts`;
 *   WebSocket close wording from `websocket-close-evidence.ts`.
 *
 * Undefined fields are deliberately NOT asserted; each carries the reason next to it.
 */
export type FailureScenario = 'native-error' | 'early-close' | 'incomplete' | 'abnormal-close';

export type FailureExpectation = {
  /** `error.kind` persisted on the failed turn; undefined where the route's kind is a finding. */
  kind: 'provider' | 'network' | undefined;
  /** Exact text after `error ` on stderr and in the persisted error; a RegExp where the wording is a runtime's. */
  message: string | RegExp | undefined;
  /** `error.retryable` as persisted. */
  retryable: boolean | undefined;
  /** `lead`: stored notice starts with it and offers `/retry turn`; `none`: no notice; undefined: unasserted. */
  notice: { lead: string } | 'none' | undefined;
  /** Text the stream delivered before failing, which stdout and the log's text deltas hold. */
  partial: 'partial' | undefined;
};

const NO_ANSWER = 'fixture resilience answer';

const unreached = (provider: string) => ({
  lead: `Could not reach ${provider} after 1 attempt. No model response was received.`,
});
const answeredWithError = (provider: string) => ({
  lead: `${provider} answered with an error after 1 attempt, so no model response was produced.`,
});

const dropped: Pick<FailureExpectation, 'kind' | 'partial'> = { kind: 'network', partial: undefined };

const wsClose = (code: number, reason: string) =>
  `WebSocket connection closed before a terminal response event. (code=${code} reason="${reason}" unsent=0)`;

/**
 * `kind`, `retryable` and `notice` are unasserted for the WebSocket closes on purpose: the same wire failure is
 * `network`/`retryable: true` with no `/retry turn` notice on openai-websocket and `provider`/`retryable: false`
 * on codex-websocket. Left open until the two lanes agree.
 */
const wsClosed = (code: number, reason: string): FailureExpectation => ({
  kind: undefined,
  message: wsClose(code, reason),
  retryable: undefined,
  notice: undefined,
  partial: 'partial',
});

const incompleteStream = (message: string): FailureExpectation => ({
  kind: 'provider',
  message,
  retryable: false,
  notice: 'none',
  partial: 'partial',
});

export const FAILURE_EXPECTATIONS: Record<string, Partial<Record<FailureScenario, FailureExpectation>>> = {
  'openai-http': {
    'native-error': {
      kind: 'provider',
      message: 'OpenAI response response.failed (Injected native provider failure) [resp_native_error]',
      retryable: false,
      notice: 'none',
      partial: undefined,
    },
    'early-close': { ...dropped, message: 'Connection error.', retryable: true, notice: unreached('openai') },
    incomplete: incompleteStream('Streamed response ended without a completion.'),
  },
  'codex-http': {
    'native-error': {
      kind: 'provider',
      message: 'Codex provider error: Injected native provider failure',
      retryable: false,
      notice: 'none',
      partial: undefined,
    },
    'early-close': { ...dropped, message: 'Connection error.', retryable: true, notice: unreached('codex') },
    incomplete: incompleteStream('Codex streamed response ended without a completed response event.'),
  },
  'openrouter-http': {
    'native-error': {
      kind: 'provider',
      message: '500 Injected native provider failure',
      retryable: true,
      notice: answeredWithError('openrouter'),
      partial: undefined,
    },
    'early-close': { ...dropped, message: 'Connection error.', retryable: true, notice: unreached('openrouter') },
    incomplete: incompleteStream('Streamed response ended without a finish reason'),
  },
  'runtime-openai-compatible-chat': {
    'native-error': {
      kind: 'provider',
      message: '500 Injected native provider failure',
      retryable: true,
      notice: answeredWithError('fixture-chat-resilience'),
      partial: undefined,
    },
    'early-close': {
      ...dropped,
      message: 'Connection error.',
      retryable: true,
      notice: unreached('fixture-chat-resilience'),
    },
    incomplete: incompleteStream('Streamed response ended without a finish reason'),
  },
  'runtime-anthropic-messages': {
    'native-error': {
      kind: 'provider',
      message: 'Injected native provider failure',
      retryable: true,
      notice: answeredWithError('fixture-anthropic-resilience'),
      partial: undefined,
    },
    // FINDING: a connection dropped before any response is `network`/retryable with a `/retry turn` notice on
    // every other HTTP route, but `provider`/non-retryable with no notice on the AI SDK routes (anthropic, google).
    // Only the kind-independent facts are asserted; the wording is undici's, hence the prefix.
    'early-close': {
      kind: undefined,
      message: /^Cannot connect to API/,
      retryable: undefined,
      notice: undefined,
      partial: undefined,
    },
    incomplete: incompleteStream('AI SDK streamed response ended without a finish event'),
  },
  'runtime-google-generate-content': {
    // FINDING: the fixture's HTTP 500 body carries "Injected native provider failure", but the user sees only the
    // status text ("Internal Server Error"); the provider's message is lost. The fixture body is not Google-shaped
    // ({error:{type,message}} rather than {error:{code,status,message}}), so this may be a fixture artifact. Wording
    // left unasserted until that is settled.
    'native-error': {
      kind: 'provider',
      message: undefined,
      retryable: true,
      notice: answeredWithError('fixture-google-resilience'),
      partial: undefined,
    },
    'early-close': {
      kind: undefined,
      message: /^Cannot connect to API/,
      retryable: undefined,
      notice: undefined,
      partial: undefined,
    },
    incomplete: incompleteStream('AI SDK streamed response ended without an authoritative native finish reason'),
  },
  'openai-websocket': {
    'native-error': {
      kind: 'provider',
      message: 'OpenAI response response.failed (Injected WS failure) [resp_ws_native-error_1]',
      retryable: false,
      notice: 'none',
      partial: undefined,
    },
    incomplete: wsClosed(1000, 'fixture complete'),
    'abnormal-close': wsClosed(1006, ''),
  },
  'codex-websocket': {
    'native-error': {
      kind: 'provider',
      message: 'Codex provider error: Injected WS failure',
      retryable: false,
      notice: 'none',
      partial: undefined,
    },
    incomplete: wsClosed(1000, 'fixture complete'),
    'abnormal-close': wsClosed(1006, ''),
  },
};

type Fact = { type: string; [key: string]: unknown };

async function readFacts(workspace: IsolatedWorkspaceLease): Promise<Fact[]> {
  const dir = workspace.paths.conversationsDir;
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  expect(files, `exactly one conversation persisted under ${dir}`).toHaveLength(1);
  const text = await readFile(join(dir, files[0]!), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { fact: Fact }).fact);
}

const ofType = (facts: readonly Fact[], type: string) => facts.filter((fact) => fact.type === type);

/**
 * Exit status, the user-visible error line, stdout, and the persisted failed turn for one failed one-shot run.
 * The caller asserts the request count, which differs in how the two servers record requests.
 */
export async function assertFailedRun(
  label: string,
  run: { exitCode: number | null; stdout: string; stderr: string; workspace: IsolatedWorkspaceLease },
  expected: FailureExpectation,
  prompt: string,
): Promise<void> {
  const context = `${label}: ${JSON.stringify({ stdout: run.stdout, stderr: run.stderr })}`;
  expect(run.exitCode, context).toBe(1);

  // stdout holds only what the stream really delivered, never an answer.
  expect(run.stdout, context).not.toContain(NO_ANSWER);
  expect(run.stdout.trim(), context).toBe(expected.partial ?? '');

  const facts = await readFacts(run.workspace);
  const started = ofType(facts, 'turn_started');
  expect(started, context).toHaveLength(1);
  expect(JSON.stringify(started[0]!.input), context).toContain(prompt);
  const ended = ofType(facts, 'turn_ended');
  expect(ended, context).toHaveLength(1);
  const turn = ended[0]!;
  const error = turn.error as { kind: string; message: string; retryable: boolean };
  expect(turn.outcome, context).toBe('failed');
  if (expected.kind) expect(error.kind, context).toBe(expected.kind);
  expect(error.message.length, context).toBeGreaterThan(0);
  if (typeof expected.message === 'string') expect(error.message, context).toBe(expected.message);
  else if (expected.message) expect(error.message, context).toMatch(expected.message);
  if (expected.retryable !== undefined) expect(error.retryable, context).toBe(expected.retryable);
  if (expected.notice === 'none') expect(turn.notice, context).toBeUndefined();
  else if (expected.notice) {
    expect(String(turn.notice), context).toContain(expected.notice.lead);
    expect(String(turn.notice), context).toContain('/retry turn');
  }
  expect(ofType(facts, 'queue_settled'), context).toMatchObject([{ outcome: 'failed' }]);

  // The user sees the persisted message, once, in the product's `error <message>` form, with no leaked internals.
  expect(run.stderr.trim(), context).toBe(`error ${error.message}`);
  expect(run.stderr, context).not.toMatch(/\bundefined\b|\[object Object\]|\n\s+at \S+/);

  // What a completed turn writes and a failed one must not: no response, no assistant item. Streamed text is
  // recorded only as deltas of the failed turn.
  expect(ofType(facts, 'model_response_completed'), context).toEqual([]);
  expect(ofType(facts, 'item'), context).toEqual([]);
  expect(
    ofType(facts, 'text_delta').map((fact) => fact.delta),
    context,
  ).toEqual(expected.partial ? [expected.partial] : []);
}
