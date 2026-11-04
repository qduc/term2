/**
 * The run policy of one Session, read from its settings. The Session keeps each
 * run's budget state and costs; this file only supplies the limits. Provider
 * chaining needs a real endpoint and account, so without one the Session sends
 * full history, which is always correct.
 */
import { getActiveCodexAccount } from '../../../source/providers/codex-auth.js';
import { getSessionAccount } from '../../../source/providers/oauth-session-account.js';
import { readRunBudgetPolicy } from '../engine/direct-recovery-budget.js';
import { DirectContinuity } from '../engine/direct-recovery-continuity.js';
import type { ModelRef } from '../model/index.js';
import type { DirectConversationRuntime } from '../session/direct-store.js';
import { ContextMilestoneReminder } from '../../../source/services/agent-runtime/context-compaction/context-milestone-reminder.js';
import type { ProfileSelection } from './tool-contract.js';

type RuntimeDeps = DirectConversationRuntime['deps'];

/**
 * Only OpenAI and Codex chain responses. Both URLs are the ones their clients
 * use. A Codex response chain belongs to one account, and a running process stays
 * pinned to the first account it authenticates as. Before that first request the
 * pin is whichever account is selected. No account means CLI credentials this
 * app cannot name, so chaining stays off.
 */
function continuityEndpoint({ provider }: ModelRef): string | undefined {
  if (provider === 'openai') return `openai:${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`;
  if (provider !== 'codex') return undefined;
  const account = getSessionAccount('codex') ?? getActiveCodexAccount()?.id;
  if (!account) return undefined;
  return `codex:${process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex'}:${account}`;
}

export function runPolicy(
  settings: ProfileSelection['settings'],
  sessionId: string,
  model: ModelRef,
): Pick<RuntimeDeps, 'recovery' | 'budget' | 'compaction' | 'continuity'> {
  const endpoint = continuityEndpoint(model);
  return {
    recovery: { maxTransientRetries: settings.get('agent.retryAttempts') },
    budget: { policy: readRunBudgetPolicy(settings) },
    compaction: {
      settings: {
        enabled: settings.get('agent.contextCompaction.enabled'),
        mode: settings.get('agent.contextCompaction.mode'),
        compactThreshold: settings.get('agent.contextCompaction.compactThreshold'),
        compactThresholdTokens: settings.get('agent.contextCompaction.compactThresholdTokens'),
      },
      maxRequestInputTokens: settings.get('agent.maxRequestInputTokens'),
    },
    ...(endpoint ? { continuity: { binding: { origin: sessionId, endpoint }, state: new DirectContinuity() } } : {}),
  };
}

/**
 * One session's rollover milestone reminders (legacy agent-client). Settings are read at each request boundary; a
 * turn without its own completed request falls back to the last one an earlier turn completed. A rollover (a new
 * backing session) starts over, as legacy's rolloverRootContext does.
 */
export function contextMilestones(settings: { get(key: string): unknown }, backingSessionId: () => string) {
  let reminder = new ContextMilestoneReminder();
  let last: number | undefined;
  let session = backingSessionId();
  const sameSession = (): boolean => {
    if (backingSessionId() === session) return true;
    session = backingSessionId();
    reminder = new ContextMilestoneReminder();
    last = undefined;
    return false;
  };
  return {
    observe: (lastInputTokens: number | undefined): readonly string[] =>
      reminder.observe((sameSession() ? lastInputTokens : undefined) ?? last, {
        enabled: (settings.get('agent.sessionRollover.enabled') as boolean | undefined) ?? true,
        milestones: (settings.get('agent.sessionRollover.milestones') as readonly number[] | undefined) ?? [],
        autoBrief: (settings.get('agent.sessionRollover.autoBrief') as boolean | undefined) ?? true,
      }),
    settle: (lastInputTokens: number | undefined): void => {
      if (sameSession() && lastInputTokens !== undefined) last = lastInputTokens;
    },
  };
}
