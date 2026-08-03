import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import { withSteeringNotice } from '../../prompts/steering-notice.js';

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
  { steering = false }: { steering?: boolean } = {},
): ProviderInputItem {
  const turn = normalizeUserTurn(input);
  const images = turn.images ?? [];
  const rawText = turn.text ?? '';
  const text = steering ? withSteeringNotice(rawText) : rawText;

  if (images.length === 0) {
    return { role: 'user', type: 'message', content: text };
  }

  const content: unknown[] = [];
  if (text) content.push({ type: 'input_text', text });
  for (const image of images) {
    content.push({ type: 'input_image', image: `data:${image.mimeType};base64,${image.data}`, detail: 'auto' });
  }

  return { role: 'user', type: 'message', content } as ProviderInputItem;
}
