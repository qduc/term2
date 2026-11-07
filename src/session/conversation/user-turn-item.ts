import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
import { normalizeUserTurn, type UserTurn } from '../../shared/types/user-turn.js';
import { conversationTimeGap } from '../../shared/conversation/conversation-time-gap.js';
import { withSteeringNotice } from '../../engine/prompts/steering-notice.js';

/**
 * The provider representation of one user turn.
 *
 * Text-only turns keep the plain string content that providers accept
 * everywhere; a turn carrying images becomes a content-part list. This is the
 * single shape for user input, whether the turn opens a conversation, resumes
 * one, or is steered into a turn already running.
 */
export function userTurnToProviderItem(
  input: string | UserTurn,
  { steering = false, history = [] }: { steering?: boolean; history?: readonly unknown[] } = {},
): ProviderInputItem {
  const turn = normalizeUserTurn(input);
  const images = turn.images ?? [];
  const rawText = turn.text ?? '';
  const text = steering ? withSteeringNotice(rawText) : rawText;

  const baseline = turn.humanInputBaseline === undefined ? {} : { humanInputBaseline: turn.humanInputBaseline };
  const gap = conversationTimeGap(turn.humanInputAt, history);
  const timing =
    turn.humanInputAt === undefined
      ? {}
      : {
          humanInputAt: turn.humanInputAt,
          // Keep the item identical after JSON persistence for strict rewind prefix checks.
          ...(gap === undefined ? {} : { conversationTimeGap: gap }),
        };

  if (images.length === 0) {
    return { role: 'user', type: 'message', content: text, ...baseline, ...timing };
  }

  const content: unknown[] = [];
  if (text) content.push({ type: 'input_text', text });
  for (const image of images) {
    content.push({ type: 'input_image', image: `data:${image.mimeType};base64,${image.data}`, detail: 'auto' });
  }

  return { role: 'user', type: 'message', content, ...baseline, ...timing } as ProviderInputItem;
}
