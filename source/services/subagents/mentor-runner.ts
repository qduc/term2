import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentResult } from './types.js';
import { SubagentSession } from './subagent-session.js';
import { loadRoleDefinition, resolvePrompt, PROMPTS_DIR } from './role-loader.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import { getProvider } from '../../providers/index.js';
import { extractFinalText, isAbortLike, safeEmit } from './utils.js';
import { selectAgentStreamItems } from '../agent-stream.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../../services/cost/model-cost.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import type { ExecutionBudget } from '../agent-runtime/execution-budget.js';

/** Upper bound on `agent.mentorSamples`; each sample is a full mentor call. */
const MAX_MENTOR_SAMPLES = 8;

/**
 * One consultation in a mentor fan-out. `model`/`provider` are absent for plain
 * sampling, where every consultation uses the configured mentor model.
 */
interface MentorConsultation {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  /** Shown in the answer's heading so the agent can attribute each opinion. */
  label?: string;
}

export class MentorRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #mentorSession: SubagentSession;
  #onEvent?: (event: ConversationEvent) => void;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    onEvent?: (event: ConversationEvent) => void;
    session?: SubagentSession;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#mentorSession = deps.session ?? new SubagentSession(randomUUID(), 'mentor');
    this.#onEvent = deps.onEvent;
  }

  reset(): void {
    this.#mentorSession.reset();
  }

  async run(
    agentId: string,
    task: string,
    signal?: AbortSignal,
    session?: SubagentSession,
    executionBudget?: ExecutionBudget,
  ): Promise<SubagentResult> {
    let slot: AcquiredChildSlot | undefined;
    let childBudget = executionBudget;
    if (executionBudget) {
      childBudget = executionBudget.createChildBudget();
      const acquired = executionBudget.tryAcquireChild();
      if (!(acquired instanceof AcquiredChildSlot)) {
        return {
          agentId,
          role: 'mentor',
          status: 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: `Budget exhausted: ${acquired.reason}${
            acquired.max !== undefined ? ` (${acquired.current}/${acquired.max})` : ''
          }`,
        };
      }
      slot = acquired;
    }
    const previousSession = this.#mentorSession;
    if (session) this.#mentorSession = session;
    try {
      try {
        const consultations = this.#resolveConsultations();
        const result =
          consultations.length > 1
            ? await this.#runSamples(agentId, task, consultations, signal)
            : await this.#runWithSession(agentId, task, this.#mentorSession, signal, consultations[0]);
        if (slot && result.usage) childBudget!.recordUsage(result.usage);
        return result;
      } catch (error: any) {
        if (!signal?.aborted && !isAbortLike(error?.message, error)) throw error;
        const usage = normalizeAgentRunUsage(error?.usage) ?? extractUsage(error);
        if (slot && usage) childBudget!.recordUsage(usage);
        if (usage) safeEmit(this.#logger, this.#onEvent, { type: 'usage_update', agentId, usage });
        return {
          agentId,
          role: 'mentor',
          status: 'cancelled',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: error?.message ?? 'The subagent run was aborted.',
          ...(usage ? { usage } : {}),
        };
      }
    } finally {
      slot?.release();
      if (session) this.#mentorSession = previousSession;
    }
  }

  async runInSession(
    agentId: string,
    task: string,
    signal: AbortSignal | undefined,
    session: SubagentSession,
  ): Promise<SubagentResult> {
    return this.run(agentId, task, signal, session, undefined);
  }

  #resolveSampleCount(): number {
    const configured = this.#settings.get('agent.mentorSamples');
    const parsed = typeof configured === 'number' ? configured : Number(configured);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(1, Math.min(MAX_MENTOR_SAMPLES, Math.floor(parsed)));
  }

  /**
   * Builds the list of consultations for one mentor call.
   *
   * A configured pool *defines* the consultations — one per entry — and
   * `agent.mentorSamples` is ignored. The two do not multiply: a pool asks
   * different models the same question, which is a different intent from
   * asking one model repeatedly, and combining them silently would make the
   * cost of a consultation hard to predict.
   */
  #resolveConsultations(): MentorConsultation[] {
    const pool = this.#settings.get('agent.mentorPool');
    if (Array.isArray(pool) && pool.length > 0) {
      return pool.slice(0, MAX_MENTOR_SAMPLES).map((entry: any) => ({
        model: entry?.model,
        provider: entry?.provider,
        reasoningEffort: entry?.reasoningEffort,
        label: entry?.model,
      }));
    }
    return Array.from({ length: this.#resolveSampleCount() }, () => ({}));
  }

  /**
   * Runs every consultation concurrently and returns all the answers.
   *
   * Each one gets its own throwaway session. Sharing one session would feed
   * answer N-1 into consultation N as conversation history, so the answers
   * would anchor on the first opinion instead of being independent — the whole
   * reason for sampling. The persistent `#mentorSession` is left untouched, so
   * single-consultation mentor mode keeps its ongoing relationship.
   */
  async #runSamples(
    agentId: string,
    task: string,
    consultations: MentorConsultation[],
    signal?: AbortSignal,
  ): Promise<SubagentResult> {
    const samples = consultations.length;
    const settled = await Promise.allSettled(
      consultations.map((consultation) =>
        this.#runWithSession(agentId, task, new SubagentSession(randomUUID(), 'mentor'), signal, consultation),
      ),
    );

    const answers: string[] = [];
    const failures: { label?: string; reason: unknown }[] = [];
    const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const costRecords: ModelRequestCost[] = [];
    let sawUsage = false;

    settled.forEach((outcome, index) => {
      const label = consultations[index]?.label;
      if (outcome.status === 'rejected') {
        failures.push({ label, reason: outcome.reason });
        return;
      }
      const result = outcome.value;
      const heading = `## Mentor sample ${index + 1} of ${samples}${label ? ` — ${label}` : ''}`;
      answers.push(`${heading}\n\n${result.finalText}`);
      if (result.usage) {
        sawUsage = true;
        usageTotals.prompt_tokens += result.usage.prompt_tokens ?? 0;
        usageTotals.completion_tokens += result.usage.completion_tokens ?? 0;
        usageTotals.total_tokens += result.usage.total_tokens ?? 0;
      }
      if (result.costRecords) costRecords.push(...result.costRecords);
    });

    if (answers.length === 0) {
      // Nothing to hand back, so surface the real failure rather than an empty
      // consultation. An abort is rethrown as-is so `run` reports `cancelled`.
      const abort = failures.find(({ reason }: any) => isAbortLike(reason?.message, reason));
      throw (abort ?? failures[0]).reason;
    }

    const sections = [...answers];
    if (failures.length > 0) {
      const detail = failures
        .map(({ label, reason }: any) => {
          const message = reason?.message ?? String(reason);
          return label ? `${label}: ${message}` : message;
        })
        .join('; ');
      sections.push(`_${failures.length} of ${samples} mentor samples failed: ${detail}_`);
    }

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: sections.join('\n\n'),
      filesChanged: [],
      toolsUsed: [],
      ...(sawUsage ? { usage: usageTotals } : {}),
      ...(costRecords.length > 0 ? { costRecords } : {}),
    };
  }

  async #runWithSession(
    agentId: string,
    task: string,
    mentorSession: SubagentSession,
    signal?: AbortSignal,
    consultation?: MentorConsultation,
  ): Promise<SubagentResult> {
    const definition = loadRoleDefinition('mentor', this.#settings);
    // A pool entry overrides the configured mentor model for this consultation
    // only. An entry may name a model without a provider, in which case it runs
    // on the mentor's usual provider.
    const mentorModelName = consultation?.model ?? definition.model;
    const mentorProvider = consultation?.provider ?? definition.provider;
    const mentorMode = this.#settings.get('app.mentorMode');

    const baseInstructions = mentorMode
      ? resolvePrompt(path.join(PROMPTS_DIR, 'mentor-mode.md'))
      : definition.instructions;

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = `${baseInstructions}\n\nEnvironment: ${envInfo}${agentsInstructions}`;

    mentorSession.switchProvider(mentorProvider);

    const providerDef = getProvider(mentorProvider);
    if (!providerDef?.createStreamedModel) {
      const providerLabel = providerDef?.label || mentorProvider;
      throw new Error(
        `${providerLabel} is configured but could not be initialized. ` +
          `Please check that all required credentials and provider settings are set.`,
      );
    }
    const streamedModel = await mentorSession.ensureModel(mentorProvider, (providerId) => {
      const definition = getProvider(providerId);
      if (!definition?.createStreamedModel) throw new Error(`${providerId} has no streamed model`);
      return definition.createStreamedModel(mentorModelName, {
        settingsService: this.#settings,
        loggingService: this.#logger,
        sessionContextService: this.#sessionContextService,
      });
    });
    if (!streamedModel)
      throw new Error(`${providerDef.label || mentorProvider} is configured but could not be initialized.`);

    const mentorAgent = mentorSession.ensureAgent(() => {
      const reasoningEffort = consultation?.reasoningEffort ?? this.#settings.get('agent.mentorReasoningEffort');
      const modelSettings: any = {
        retry: { maxRetries: this.#settings.get('agent.retryAttempts') ?? 2 },
      };
      if (reasoningEffort && reasoningEffort !== 'default') {
        modelSettings.reasoning = { effort: reasoningEffort, summary: 'auto' };
      }

      return {
        name: definition.name,
        model: mentorModelName,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions,
        tools: [],
      } satisfies ApplicationAgent;
    }) as ApplicationAgent;

    mentorSession.addUserMessage(task);

    const supportsChaining = providerDef.capabilities?.supportsConversationChaining ?? false;
    const input = mentorSession.getInput(task, supportsChaining);
    const loop = new ApplicationRunLoop({
      resolveModel: () => streamedModel,
      resolveMaxParallelToolCalls: () => this.#settings.get('agent.maxParallelToolCalls'),
    });
    const stream = loop.startStream(mentorAgent, input, {
      ...(signal ? { signal } : {}),
      maxTurns: definition.maxTurns,
      ...(supportsChaining && mentorSession.previousResponseId
        ? { previousResponseId: mentorSession.previousResponseId }
        : {}),
    });
    try {
      await stream.completed;
    } catch (error: any) {
      if (stream.runUsage !== undefined) error.usage = stream.runUsage;
      throw error;
    }
    mentorSession.appendOutput({ output: selectAgentStreamItems(stream), lastResponseId: stream.lastResponseId });

    const usage = normalizeAgentRunUsage(stream.runUsage) ?? extractUsage(stream);
    if (usage) safeEmit(this.#logger, this.#onEvent, { type: 'usage_update', agentId, usage });

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: extractFinalText(stream),
      filesChanged: [],
      toolsUsed: [],
      usage,
      costRecords: stream.runCostRecords as ModelRequestCost[] | undefined,
    };
  }
}
