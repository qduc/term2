/** Encode protocol-owned public state into the existing v1 control read schema.
 * Missing public data is null, never fabricated from private Session internals.
 */
import os from 'node:os';
import process from 'node:process';
import type { JsonValue, WireInteraction, WireSnapshot } from '../../protocol/direct-wire.js';
import { projectControlPhase, type ControlTopic } from './transport.js';
import type { DirectControlPortOptions } from './types.js';

function interactions(state: WireSnapshot) {
  const foreground = state.pendingInteractions.find(
    (item) =>
      !item.parentExecutionId &&
      (item.turnId === state.activeTurnId ||
        (state.activeTurnId === null && !state.tasks.some((task) => task.turnId === item.turnId))),
  );
  return { foreground, nested: state.pendingInteractions.find((item) => item !== foreground) };
}

function calls(state: WireSnapshot) {
  return state.tools
    .filter((tool) => tool.status !== 'completed')
    .map((tool) => ({
      callId: tool.callId ?? null,
      toolName: tool.toolName,
      status: tool.status,
      executionId: tool.executionId,
      turnId: tool.turnId,
      parentExecutionId: tool.parentExecutionId ?? null,
    }));
}

/** Project current phase, queue, execution identities and model without owning execution. */
export function controlStatus(state: WireSnapshot, options: DirectControlPortOptions): unknown {
  const pending = interactions(state);
  const metadata = options.metadata(state);
  return {
    ...projectControlPhase({
      foregroundToolName: pending.foreground?.kind === 'question' ? 'ask_user' : pending.foreground?.toolName,
      hasNestedApproval: pending.nested !== undefined,
      activeTurn: state.status === 'running' || state.status === 'awaiting_interaction',
      queueOwnsSubmissions: state.queueState !== 'idle',
      queueActive: state.queue.length > 0,
    }),
    // Budget pauses are not invented tool calls; the v1 phase still denotes
    // terminal-only approval, with exact budget identities in get(pending).
    ...(!pending.foreground && !pending.nested && state.pendingBudgets?.length
      ? { phase: 'awaiting_approval', waitKind: 'approval' }
      : {}),
    queueStateKind: state.queueState,
    queuePauseReason: state.queuePauseReason ?? null,
    sessionId: state.sessionId,
    queue: state.queue.map((item) => ({
      id: item.messageId,
      text: item.text.slice(0, 500),
      stage: item.delivery === 'steering' ? 'pending_steer' : 'queued',
      clientRequestId: item.clientRequestId,
      content: item.content ?? null,
      origin: item.origin ?? null,
      receivedAt: item.receivedAt ?? null,
      turnId: item.turnId ?? null,
    })),
    currentTool: calls(state)[0] ?? null,
    context: { contextWindow: metadata.contextWindow ?? null, promptTokens: null },
    cost: metadata.cost ?? null,
    model: state.model.model,
    provider: state.model.provider,
    reasoningEffort: state.configuration.reasoning ?? null,
  };
}

function object(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly [key: string]: JsonValue })
    : undefined;
}

function questions(interaction: WireInteraction) {
  if (interaction.questions)
    return interaction.questions.slice(0, 5).map((question) => ({
      id: question.id,
      question: question.prompt,
      options: question.options.slice(0, 8).map((option) => ({ label: option.label.slice(0, 80) })),
      is_multi_select: question.multiple,
    }));
  const items = object(interaction.input)?.questions;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).flatMap((item) => {
    const question = object(item);
    if (!question || typeof question.question !== 'string') return [];
    return [
      {
        question: question.question,
        options: (Array.isArray(question.options) ? question.options : []).slice(0, 8).flatMap((item) => {
          const option = object(item);
          return typeof option?.label === 'string' ? [{ label: option.label.slice(0, 80) }] : [];
        }),
        is_multi_select: question.is_multi_select === true,
      },
    ];
  });
}

function pending(state: WireSnapshot) {
  const { foreground, nested } = interactions(state);
  const callId = (item: WireInteraction) =>
    state.tools.find((tool) => tool.executionId === item.executionId)?.callId ?? null;
  const common = (item: WireInteraction) => ({
    requestId: item.requestId,
    turnId: item.turnId,
    executionId: item.executionId ?? null,
    parentExecutionId: item.parentExecutionId ?? null,
    toolName: item.toolName,
    argumentsExcerpt: JSON.stringify(item.input).slice(0, 500),
  });
  return {
    foreground: foreground
      ? {
          ...common(foreground),
          interactionId: foreground.requestId,
          revision: foreground.presentation?.revision ?? null,
          callId: callId(foreground),
          checkIn: foreground.presentation?.checkIn ?? false,
          currentAskUserQuestionIndex: foreground.presentation?.currentAskUserQuestionIndex ?? null,
          ...(foreground.kind === 'question' ? { questions: questions(foreground) } : {}),
        }
      : null,
    nested: nested ? { ...common(nested), nestedCallId: callId(nested) } : null,
    // Keep every request answerable by its real identity, not only the v1 first two slots.
    interactions: state.pendingInteractions.map((item) => ({ ...common(item), kind: item.kind })),
    budgets: state.pendingBudgets ?? [],
  };
}

/** Read a v1 topic; composition supplies process/settings metadata, not runtime authority. */
export function controlGet(state: WireSnapshot, topic: ControlTopic, options: DirectControlPortOptions): unknown {
  const metadata = options.metadata(state);
  switch (topic) {
    case 'session':
      return {
        sessionId: state.sessionId,
        socketName: options.controlSocket.name,
        pid: process.pid,
        host: os.hostname(),
        cwd: process.cwd(),
        workspaceRoot: metadata.workspaceRoot,
        version: metadata.version,
        createdAt: metadata.createdAt,
        logPath: metadata.logPath,
        startedAt: options.controlSocket.startedAt,
        profileId: metadata.profileId ?? null,
      };
    case 'model':
      return {
        provider: state.model.provider,
        model: state.model.model,
        reasoningEffort: state.configuration.reasoning ?? null,
        autoApproveMode: metadata.autoApproveMode ?? null,
      };
    case 'usage':
      return {
        cumulative: {
          prompt_tokens: state.usage.inputTokens,
          completion_tokens: state.usage.outputTokens,
          cache_read_tokens: state.usage.cachedInputTokens,
          cache_creation_tokens: metadata.cacheCreationTokens ?? null,
        },
        contextWindow: metadata.contextWindow ?? null,
        cost: metadata.cost ?? null,
        lastRequest: null,
      };
    case 'pending':
      return pending(state);
    case 'tools':
      return { calls: calls(state) };
    case 'background':
      return {
        tasks: state.tasks.slice(0, 32).map((task) => ({
          kind: task.kind ?? (task.agentId ? 'subagent' : null),
          id: task.id,
          status: task.status,
          startedAt: task.startedAt ?? null,
          turnId: task.turnId ?? null,
          sessionId: task.sessionId ?? null,
          parentExecutionId: task.parentExecutionId ?? null,
          sourceCallId: task.sourceCallId ?? null,
          origin: task.origin ?? null,
          mode: task.mode ?? null,
          completedAt: task.completedAt ?? null,
          labelExcerpt: (task.label ?? task.name ?? task.text ?? task.role ?? '').slice(0, 500),
        })),
      };
  }
}
