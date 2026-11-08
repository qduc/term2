/** Tool-free model bridge used by the application's approval evaluators. */
import { randomUUID } from 'node:crypto';
import type { ModelAffinity, ModelRegistry, ItemId } from '../../model/index.js';
import type { ShellAutoApprovalAgentClient } from '../../session/conversation-agent-client.js';
import type { ProfileSelection } from '../tool-contract.js';

/** One tool-free model request for the existing approval evaluator; never starts an agent loop. */
export function createApprovalModelClient(
  models: ModelRegistry,
  { settings }: ProfileSelection,
  surfaceSignal: AbortSignal,
  parentAffinity: ModelAffinity,
): ShellAutoApprovalAgentClient {
  const key = `${parentAffinity.conversationKey}:evaluator`;
  const affinity = { conversationKey: key, cacheKey: key, routingKey: key };
  return {
    async chat(message, options = {}) {
      const configured = settings.get('agent.modelSelection');
      const model = { provider: options.provider ?? configured.provider, model: options.model ?? configured.model };
      const effort = options.reasoningEffort;
      const signal = options.signal ? AbortSignal.any([options.signal, surfaceSignal]) : surfaceSignal;
      signal.throwIfAborted();
      let deltas = '';
      const completed: string[] = [];
      let ended = false;
      for await (const event of models.resolve(model).stream(
        {
          model,
          instructions: options.instructions ?? '',
          affinity,
          tools: [],
          input: [
            {
              type: 'user_message',
              id: `approval:${randomUUID()}` as ItemId,
              content: [{ type: 'text', text: message }],
            },
          ],
          ...(effort && effort !== 'default' ? { reasoning: effort } : {}),
          ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        },
        signal,
      )) {
        if (event.type === 'text_delta') deltas += event.delta;
        if (event.type === 'item' && event.item.type === 'assistant_message') {
          completed.push(
            event.item.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          );
        }
        if (event.type === 'done') {
          if (event.stopReason !== 'end_turn') throw new Error(`Approval model stopped with ${event.stopReason}`);
          ended = true;
        }
      }
      if (!ended) throw new Error('Approval model ended without a completion');
      return completed.length > 0 ? completed.join('') : deltas;
    },
  };
}
