/**
 * Wires one headless run: surface, provider registry, log, conversation, client.
 *
 * `cli.ts` owns signals. The first signal calls `cancel()` and waits for
 * `result`, and only `result` decides the exit code. `kind: 'cancelled'` means
 * the terminal fact is durable; a failed append during cancel is `'failed'`.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationGuard, GenerationStreamDeadlines } from '../../../source/services/agent-runtime/generation-guard.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { renderTurn } from '../clients/headless/index.js';
import type { HeadlessEvent, HeadlessIo } from '../clients/headless/index.js';
import type { TurnEvent } from '../engine/index.js';
import type { Item, ItemId, Model, ModelEvent, ModelRef, ModelRegistry, ModelRequest } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import { createConversation } from '../session/conversation.js';
import type { Conversation, Turn } from '../session/conversation.js';
import { createLog } from '../session/log.js';
import { loadSurface } from './agent-surface.js';
import type { ProfileSelection } from './agent-surface.js';

export type RunRequest = {
  readonly prompt: string;
  /** Already checked by `cli.ts` (D9). */
  readonly conversationsDir: string;
  readonly selection: ProfileSelection;
  readonly io: HeadlessIo;
};

export type RunResult = { readonly kind: 'completed' | 'cancelled' | 'failed' };

export type RunHandle = {
  readonly result: Promise<RunResult>;
  /** False before the turn starts and after it ends; a signal then exits at once. */
  turnActive(): boolean;
  cancel(): void;
};

// The session's events must stay renderable by the client without either layer
// importing the other. Only app sees both, so the check lives here.
type Renderable<T extends HeadlessEvent> = T;
export type RenderedEvent = Renderable<TurnEvent>;

export function run(request: RunRequest): RunHandle {
  let turn: Turn | null = null;
  let active = false;

  const execute = async (): Promise<RunResult> => {
    const { selection, io, prompt, conversationsDir } = request;
    let conversation: Conversation | null = null;
    try {
      const surface = loadSurface(selection);
      const { notice, profileName: _profileName, ...settings } = surface;
      const model = selection.settings.get('agent.modelSelection') as ModelRef;
      const id = `conv_${randomUUID()}`;
      const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));

      fs.mkdirSync(conversationsDir, { recursive: true });
      conversation = createConversation({
        log: createLog(conversationsDir, id),
        models: withGenerationGuard(createProviderRegistry(selection), selection),
        meta: {
          id,
          workspace: process.cwd(),
          model,
          ...(surface.reasoning !== undefined ? { reasoning: surface.reasoning } : {}),
          profile: {
            id: profile.activeProfileId,
            version: profile.activeProfileVersion,
            digest: profile.activeProfileDigest,
          },
          appVersion: appVersion(),
        },
      });

      const input: Item = {
        type: 'user_message',
        id: randomUUID() as ItemId,
        content: [{ type: 'text', text: prompt }],
      };
      turn = conversation.run({ ...settings, model, input: [input], ...(notice ? { notice } : {}) });
      active = true;

      // The session context is an AsyncLocalStorage, and the provider reads it
      // while this call drives the stream.
      const started = turn;
      const context = { sessionId: id, sessionStartedAt: new Date().toISOString(), promptCacheKey: id };
      const { kind } = await selection.sessionContext.runWithContext(context, () => renderTurn(started.events, io));
      return { kind: kind === 'completed' || kind === 'cancelled' ? kind : 'failed' };
    } catch (error) {
      io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
      return { kind: 'failed' };
    } finally {
      active = false;
      try {
        conversation?.close();
      } catch {
        // The result is already durable or already failed; a close error changes neither.
      }
    }
  };

  return {
    result: execute(),
    turnActive: () => active,
    cancel: () => turn?.cancel(),
  };
}

/**
 * The old run loop's per-request limits: a stalled stream and oversized text end
 * the turn as a failure, with the same settings and messages. Above the provider,
 * so a trip is not retried. Text passes `observeText` before it can be shown.
 */
function withGenerationGuard(models: ModelRegistry, { settings }: ProfileSelection): ModelRegistry {
  const stream = async function* (model: Model, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const maxCharacters = settings.get('agent.maxStreamOutputChars');
    const guard = new GenerationGuard({
      maxOutputCharacters: maxCharacters,
      maxTextCharacters: maxCharacters,
      maxReasoningCharacters: maxCharacters,
      requestDeadlineMs: settings.get('agent.maxModelRequestDurationMs'),
      maxStreamIdleMs: settings.get('agent.maxModelStreamIdleMs'),
    });
    const stop = new AbortController();
    const deadlines = new GenerationStreamDeadlines(
      { totalMs: guard.requestDeadlineMs, idleMs: guard.maxStreamIdleMs },
      () => stop.abort(),
      () => guard.progress,
    );
    const events = model.stream(request, AbortSignal.any([signal, stop.signal]))[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await deadlines.wait(events.next());
        if (next.done) return;
        deadlines.recordActivity();
        if (next.value.type === 'text_delta') guard.observeText(next.value.delta);
        if (next.value.type === 'reasoning_delta') guard.observeReasoning(next.value.delta);
        yield next.value;
      }
    } finally {
      deadlines.dispose();
      stop.abort();
      void events.return?.()?.catch(() => undefined);
    }
  };
  return {
    list: () => models.list(),
    resolve(ref) {
      const model = models.resolve(ref);
      return { ...model, stream: (request, signal) => stream(model, request, signal) };
    },
  };
}

function appVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@qduc/term2') return String(pkg.version);
    } catch {
      // No package.json here; keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return 'unknown';
    directory = parent;
  }
}
