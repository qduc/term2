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
import type { ProfileSelection } from './tool-contract.js';

type RuntimeDeps = DirectConversationRuntime['deps'];

/**
 * Only OpenAI and Codex chain responses. Both URLs are the ones their clients
 * use. A Codex response chain belongs to one account, and a running process stays
 * pinned to the first account it authenticates as. Before that first request the
 * pin is whichever account is selected. No account means the Codex CLI's own
 * credentials; legacy chains on those too, so they bind as one `cli` account.
 */
function continuityEndpoint({ provider }: ModelRef): string | undefined {
  if (provider === 'openai') return `openai:${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`;
  if (provider !== 'codex') return undefined;
  const account = getSessionAccount('codex') ?? getActiveCodexAccount()?.id ?? 'cli';
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
