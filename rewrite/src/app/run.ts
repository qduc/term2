/** Direct headless composition: native Session owns durability and effect release. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationGuard, GenerationStreamDeadlines } from '../../../source/services/agent-runtime/generation-guard.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { renderTurn } from '../clients/headless/index.js';
import type { HeadlessEvent } from '../clients/headless/index.js';
import type { InteractionDecision, TurnEvent } from '../engine/index.js';
import type { Item, ItemId, Model, ModelEvent, ModelRef, ModelRegistry, ModelRequest } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import { createConversation, openConversation } from '../session/conversation.js';
import type { Conversation, Turn } from '../session/conversation.js';
import type { Fact, SessionStartedFact } from '../session/facts.js';
import { createLog, openLog, readFacts } from '../session/log.js';
import type { ConversationLog } from '../session/log.js';
import { replay } from '../session/replay.js';
import { loadSurface } from './agent-surface.js';
import type { AgentSurface, ProfileSelection } from './agent-surface.js';
import type { RunHandle, RunRequest, RunResult } from './run-types.js';
export type { RunHandle, RunRequest, RunResult } from './run-types.js';

// Keep the client structural: neither engine nor Session is imported there.
type Renderable<T extends HeadlessEvent> = T;
export type RenderedEvent = Renderable<TurnEvent>;

/** Starts one run; result settles only after the Session has drained its engine. */
export function run(request: RunRequest): RunHandle {
  let turn: Turn | null = null;
  let active = false;
  const stopped = new AbortController();

  const execute = async (): Promise<RunResult> => {
    const { selection, io, prompt, conversationsDir } = request;
    let conversation: Conversation | null = null;
    let log: ConversationLog | null = null;
    let surface: AgentSurface | null = null;
    let policyFailed = false;
    try {
      // Refusal/metadata/workspace validation precedes assembly, writable open,
      // directory creation, and every possible provider or tool operation.
      const resumed = prepareResume(request);
      surface = loadSurface(selection, { autoApprove: request.autoApprove ?? false, interactive: false });
      const { notice, profileName: _profileName, runtime, decideInteraction, ...settings } = surface;
      const model = selection.settings.get('agent.modelSelection') as ModelRef;
      const id = resumed?.meta.id ?? `conv_${randomUUID()}`;
      const models = withGenerationGuard(createProviderRegistry(selection), selection);
      const deps = {
        models,
        tools: runtime.tools,
        toolContext: runtime.toolContext,
        maxParallelToolCalls: runtime.maxParallelToolCalls,
      };
      if (resumed) {
        log = openLog(resumed.path);
        conversation = openConversation({ ...deps, log, facts: resumed.facts });
      } else {
        const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));
        fs.mkdirSync(conversationsDir, { recursive: true });
        log = createLog(conversationsDir, id);
        conversation = createConversation({
          ...deps,
          log,
          meta: {
            id,
            workspace: fs.realpathSync(process.cwd()),
            model,
            ...(settings.reasoning !== undefined ? { reasoning: settings.reasoning } : {}),
            profile: {
              id: profile.activeProfileId,
              version: profile.activeProfileVersion,
              digest: profile.activeProfileDigest,
            },
            appVersion: appVersion(),
          },
        });
      }
      const input: Item = {
        type: 'user_message',
        id: randomUUID() as ItemId,
        content: [{ type: 'text', text: prompt }],
      };
      const context = {
        sessionId: id,
        sessionStartedAt: resumed?.startedAt ?? new Date().toISOString(),
        promptCacheKey: id,
      };
      const owner = conversation;
      const acceptedLog = log;
      const { kind } = await selection.sessionContext.runWithContext(context, async () => {
        // startTurn may start work eagerly: creation and all subsequent policy /
        // provider work must inherit this same session AsyncLocalStorage scope.
        const started = owner.run({ ...settings, model, input: [input], ...(notice ? { notice } : {}) });
        turn = started;
        active = true;
        if (stopped.signal.aborted) started.cancel();
        async function* events(): AsyncGenerator<TurnEvent, void> {
          for await (const event of started.events) {
            yield event;
            if (event.type !== 'interaction_required' || stopped.signal.aborted) continue;
            try {
              const history = replay(readFacts(acceptedLog.path)).history;
              const decision = await untilCancelled(decideInteraction(event.request, history), stopped.signal);
              if (decision) {
                const answer = started.answer(event.request.requestId, decision);
                if (answer.kind === 'failed') throw new Error(answer.error.message);
              }
            } catch (error) {
              policyFailed = true;
              io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
              started.cancel();
            }
          }
        }
        return renderTurn(events(), io);
      });
      return { kind: !policyFailed && (kind === 'completed' || kind === 'cancelled') ? kind : 'failed' };
    } catch (error) {
      io.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
      return { kind: 'failed' };
    } finally {
      try {
        if (conversation) await conversation.close();
        else log?.close();
      } catch {
        // The durable terminal (or write failure) has already decided the result.
      } finally {
        active = false;
        try {
          await surface?.runtime.dispose?.();
        } catch {
          /* Do not mask the durable result. */
        }
      }
    }
  };
  return {
    result: execute(),
    turnActive: () => active,
    cancel() {
      stopped.abort();
      turn?.cancel();
    },
  };
}

const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Resumed = {
  readonly path: string;
  readonly facts: readonly Fact[];
  readonly meta: SessionStartedFact;
  readonly startedAt: string;
};

/** Exact direct resume only. This function never opens a writer or changes data. */
function prepareResume({ resumeId, conversationsDir, selection, profileExplicit }: RunRequest): Resumed | null {
  if (resumeId !== undefined && !DIRECT_ID.test(resumeId))
    throw new Error('resume requires an exact direct conversation ID');
  // Check in app as well as CLI: programmatic callers have the same isolation
  // contract. No old index, legacy file contents, or symlink target is read.
  try {
    const incompatible = fs
      .readdirSync(conversationsDir, { withFileTypes: true })
      .find((entry) => !entry.isFile() || !entry.name.endsWith('.jsonl') || !DIRECT_ID.test(entry.name.slice(0, -6)));
    if (incompatible)
      throw new Error(
        `Refusing conversations directory containing a non-direct entry: ${JSON.stringify(incompatible.name)}`,
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (resumeId === undefined) return null;
  const logPath = path.join(conversationsDir, `${resumeId}.jsonl`);
  const facts = readFacts(logPath);
  const meta = facts[0];
  if (meta?.type !== 'session_started' || meta.id !== resumeId)
    throw new Error('resume conversation metadata does not match its ID');
  if (fs.realpathSync(meta.workspace) !== fs.realpathSync(process.cwd()))
    throw new Error('resume conversation belongs to a different workspace');
  replay(facts);
  // Metadata is not a current-request activation notice. Surface construction
  // runs after these non-persistent overrides and primes only the new notice.
  if (!profileExplicit) selection.settings.set('app.activeProfileId', meta.profile.id, { persist: false });
  selection.settings.set('agent.modelSelection', meta.model, { persist: false });
  selection.settings.set('agent.reasoningEffort', meta.reasoning ?? 'default', { persist: false });
  const firstLine = fs.readFileSync(logPath, 'utf8').split('\n', 1)[0]!;
  const startedAt = String((JSON.parse(firstLine) as { at: string }).at);
  return { path: logPath, facts, meta, startedAt };
}

/** Cancellation stops waiting on advisory policy without detaching tool cleanup. */
async function untilCancelled(
  operation: Promise<InteractionDecision>,
  signal: AbortSignal,
): Promise<InteractionDecision | null> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return null;
  }
  let onAbort: () => void = () => {};
  const cancelled = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
