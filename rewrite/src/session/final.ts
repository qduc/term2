/** Public terminal evidence from the accepted root audit, never from UI state or provider history. */
import type { Item as PublicAssistantItem } from '../../../source/contracts/conversation-items.js';
import type { CommandMessage } from '../../../source/tools/types.js';
import type { TurnId } from '../engine/index.js';
import type { ModelRequestCost } from '../engine/recovery-budget.js';
import type { Item, Usage } from '../model/index.js';
import type { Fact } from './facts.js';

export type DirectFinalItem = {
  /** Present only for an actual accepted Item; partial text has no invented ID. */
  readonly id?: string;
  readonly modelStep?: number;
  readonly evidence: 'item' | 'text_delta';
  readonly item: PublicAssistantItem;
};

export type DirectFinalWindow = {
  readonly version: 'public-turn-v1';
  readonly turnId: TurnId;
  /** Present only when a read-only projection rebuilt this window from accepted
   * facts because the original terminal predates final-window persistence. */
  readonly derivedFromAcceptedFacts?: true;
  /** Actual accepted public items, with native IDs kept separate from provider identities. */
  readonly items: readonly DirectFinalItem[];
  readonly record: {
    readonly type: 'final';
    readonly finalText: string;
    readonly reasoningText?: string;
    readonly turnItems: readonly PublicAssistantItem[];
    readonly usage?: {
      readonly prompt_tokens: number;
      readonly completion_tokens: number;
      readonly total_tokens: number;
      readonly reasoning_tokens?: number;
      readonly cache_read_tokens?: number;
    };
    /** Exact complete source-formatted DTOs accepted in root tool display, first-ID order/latest value. */
    readonly commandMessages: readonly CommandMessage[];
    /** Stable request IDs, root+descendants+summary, latest accepted value at THIS terminal cut. */
    readonly costRecords: readonly ModelRequestCost[];
    readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked' | 'budget_exhausted';
  };
  /** Available in accepted tool_finished publication, not proof of delivery to any particular client. */
  readonly liveEligibleCommandMessageIds: readonly string[];
  readonly coverage: {
    readonly items: 'complete_public_items' | 'private_or_unrepresentable_items_omitted';
    readonly reasoning: 'accepted_summaries';
    readonly usage: 'accepted_root_observations';
    readonly commands: 'source_displays_only';
    readonly costs: 'accepted_tree_at_terminal';
  };
};

/** Recognize only complete source-formatted command DTOs. No output-to-command guessing. */
export function directPublicCommandMessages(display: unknown): readonly CommandMessage[] {
  const candidates = Array.isArray(display)
    ? display
    : display && typeof display === 'object' && 'messages' in display
    ? display.messages
    : undefined;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const message = value as Record<string, unknown>;
    const {
      id,
      sender,
      status,
      command,
      output,
      success,
      failureReason,
      isApprovalRejection,
      autoApprovedByLlm,
      toolName,
      toolArgs,
      callId,
    } = message;
    if (
      typeof id !== 'string' ||
      sender !== 'command' ||
      typeof command !== 'string' ||
      typeof output !== 'string' ||
      (status !== 'pending' &&
        status !== 'running' &&
        status !== 'completed' &&
        status !== 'failed' &&
        status !== 'aborted' &&
        status !== 'unknown') ||
      (success !== undefined && typeof success !== 'boolean') ||
      (isApprovalRejection !== undefined && typeof isApprovalRejection !== 'boolean') ||
      (autoApprovedByLlm !== undefined && typeof autoApprovedByLlm !== 'boolean') ||
      (failureReason !== undefined && typeof failureReason !== 'string') ||
      (toolName !== undefined && typeof toolName !== 'string') ||
      (callId !== undefined && typeof callId !== 'string')
    )
      return [];
    // Public allowlist: never forward a future display/provider field implicitly.
    const result: CommandMessage = {
      id,
      sender,
      status,
      command,
      output,
      ...(success !== undefined ? { success } : {}),
      ...(isApprovalRejection !== undefined ? { isApprovalRejection } : {}),
      ...(autoApprovedByLlm !== undefined ? { autoApprovedByLlm } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolArgs !== undefined ? { toolArgs: structuredClone(toolArgs) } : {}),
      ...(callId !== undefined ? { callId } : {}),
    };
    return [result];
  });
}

/** Rebuild the public terminal projection from its accepted prefix, including
 * audit evidence preceding history edits. Current-format reconstruction is not
 * a legacy conversion; it changes no log bytes. */
export function recoverDirectFinalWindow(
  facts: readonly Fact[],
  terminal: Extract<Fact, { type: 'turn_ended' }>,
): DirectFinalWindow | undefined {
  if (terminal.finalWindow !== undefined) return terminal.finalWindow;
  if (!facts.some((fact) => fact.type === 'turn_started' && fact.turnId === terminal.turnId)) return undefined;
  return captureDirectFinalWindow(facts, terminal);
}

export function captureDirectFinalWindow(
  facts: readonly Fact[],
  terminal: Extract<Fact, { type: 'turn_ended' }>,
): DirectFinalWindow {
  const { turnId } = terminal;
  const items = new Map<string | symbol, DirectFinalItem>();
  const partials = new Map<number | undefined, symbol>();
  const completedSteps = new Set<number>();
  const executions = new Map<string, string>();
  const commands = new Map<string, CommandMessage>();
  const costs = new Map<string, ModelRequestCost>();
  let usage: Usage | undefined;
  let omitted = false;
  for (const fact of facts) {
    if (fact.type === 'request_cost_recorded' && fact.rootTurnId === turnId)
      costs.set(fact.record.requestId, structuredClone(fact.record));
    if (!('turnId' in fact) || fact.turnId !== turnId) continue;
    if (fact.type === 'usage') {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + fact.usage.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + fact.usage.outputTokens,
        cachedInputTokens: (usage?.cachedInputTokens ?? 0) + fact.usage.cachedInputTokens,
      };
    }
    if (fact.type === 'tool_started') executions.set(fact.executionId, fact.toolName);
    if (fact.type === 'tool_finished')
      for (const message of directPublicCommandMessages(fact.result.display)) commands.set(message.id, message);
    if (fact.type === 'text_delta' && fact.delta) {
      if (fact.modelStep !== undefined && completedSteps.has(fact.modelStep)) continue;
      // The symbol is an internal ordering slot, never a public identity/cursor.
      let slot = partials.get(fact.modelStep);
      if (slot === undefined) {
        slot = Symbol();
        partials.set(fact.modelStep, slot);
      }
      const previous = items.get(slot)?.item;
      items.set(slot, {
        evidence: 'text_delta',
        ...(fact.modelStep !== undefined ? { modelStep: fact.modelStep } : {}),
        item: { type: 'assistant_text', text: (previous?.type === 'assistant_text' ? previous.text : '') + fact.delta },
      });
    }
    if (fact.type !== 'item') continue;
    if (fact.display === false) {
      omitted = true;
      continue;
    }
    const item = fact.item;
    if (item.type === 'assistant_message' && fact.modelStep !== undefined) {
      completedSteps.add(fact.modelStep);
      const partial = partials.get(fact.modelStep);
      if (partial !== undefined) items.delete(partial);
      partials.delete(fact.modelStep);
    }
    if (item.type === 'tool_call' && fact.executionId) executions.set(fact.executionId, item.toolName);
    const publicItem = publicAssistantItem(item, fact.executionId ? executions.get(fact.executionId) : undefined);
    if (publicItem)
      items.set(item.id, {
        id: item.id,
        evidence: 'item',
        item: publicItem,
        ...(fact.modelStep !== undefined ? { modelStep: fact.modelStep } : {}),
      });
    else if (item.type !== 'user_message') omitted = true;
    if (
      (item.type === 'assistant_message' && item.content.some((part) => part.type !== 'text')) ||
      (item.type === 'tool_result' && item.providerOutput !== undefined) ||
      (item.type === 'reasoning' && (item.opaque !== undefined || item.providerMetadata !== undefined)) ||
      (item.type === 'tool_call' && item.providerMetadata !== undefined)
    )
      omitted = true;
  }
  const entries = [...items.values()];
  const texts = entries.filter(({ item }) => item.type === 'assistant_text');
  // finalText is the last textual response; earlier work remains in items/turnItems.
  const finalStep = texts.at(-1)?.modelStep;
  const reasoning = entries.flatMap(({ item }) => (item.type === 'reasoning' ? [item.text] : []));
  return {
    version: 'public-turn-v1',
    turnId,
    items: entries,
    record: {
      type: 'final',
      finalText: texts
        .flatMap(({ item, modelStep }) =>
          modelStep === finalStep && item.type === 'assistant_text' ? [item.text] : [],
        )
        .join('\n\n'),
      turnItems: entries.map(({ item }) => item),
      ...(reasoning.length ? { reasoningText: reasoning.join('\n\n') } : {}),
      ...(usage
        ? {
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
              cache_read_tokens: usage.cachedInputTokens,
            },
          }
        : {}),
      commandMessages: [...commands.values()],
      costRecords: [...costs.values()],
      ...(terminal.terminalCause ? { terminalCause: terminal.terminalCause } : {}),
    },
    liveEligibleCommandMessageIds: [...commands.keys()],
    coverage: {
      items: omitted ? 'private_or_unrepresentable_items_omitted' : 'complete_public_items',
      reasoning: 'accepted_summaries',
      usage: 'accepted_root_observations',
      commands: 'source_displays_only',
      costs: 'accepted_tree_at_terminal',
    },
  };
}

function publicAssistantItem(item: Item, toolName?: string): PublicAssistantItem | undefined {
  switch (item.type) {
    case 'assistant_message':
      return {
        type: 'assistant_text',
        text: item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        text: item.summary,
        ...(item.providerItemId !== undefined ? { providerItemId: item.providerItemId } : {}),
      };
    case 'tool_call':
      return {
        type: 'tool_call',
        callId: item.callId,
        toolName: item.toolName,
        arguments: structuredClone(item.input),
      };
    case 'tool_result':
      return toolName
        ? {
            type: 'tool_result',
            callId: item.callId,
            toolName,
            status: item.isError ? 'failed' : 'completed',
            output: item.output,
          }
        : undefined;
    default:
      return undefined;
  }
}
