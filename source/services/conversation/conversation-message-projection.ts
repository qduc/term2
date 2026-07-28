export const SHELL_CONTEXT_PREFIX = '[Previous Shell Session]';
export const LEGACY_MODE_NOTICE_PREFIX = '[Mode Notice] ';

export type ConversationMessageRole = 'user' | 'assistant' | 'system';

export interface ConversationMessageImage {
  image: string;
  detail?: unknown;
}

/**
 * Read-only view of a provider conversation message. This deliberately does
 * not replace the provider item: callers retain it for replay and persistence.
 */
export interface ConversationMessageProjection {
  role: ConversationMessageRole;
  text: string;
  images: ConversationMessageImage[];
  imageCount: number;
  isSynthetic: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const messageRecord = (item: unknown): Record<string, unknown> | null => {
  const record = asRecord(item);
  if (!record) return null;
  return asRecord(record.rawItem) ?? record;
};

const isRole = (value: unknown): value is ConversationMessageRole =>
  value === 'user' || value === 'assistant' || value === 'system';

/**
 * Projects direct provider messages and one-level SDK `{ rawItem }` wrappers.
 * Tool, reasoning, and malformed non-message items intentionally return null.
 */
export function projectConversationMessage(item: unknown): ConversationMessageProjection | null {
  const message = messageRecord(item);
  if (!message || message.type !== 'message' || !isRole(message.role)) return null;

  const content = message.content;
  if (typeof content === 'string') {
    return {
      role: message.role,
      text: content,
      images: [],
      imageCount: 0,
      isSynthetic:
        message.role === 'user' &&
        (content.startsWith(SHELL_CONTEXT_PREFIX) || content.startsWith(LEGACY_MODE_NOTICE_PREFIX)),
    };
  }

  const parts = Array.isArray(content)
    ? content.map(asRecord).filter((part): part is Record<string, unknown> => !!part)
    : [];
  const text = parts
    .filter((part) => (part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  const imageCount = parts.filter((part) => part.type === 'input_image').length;
  const images = parts
    .filter((part) => part.type === 'input_image' && typeof part.image === 'string')
    .map((part) => ({ image: part.image as string, ...(part.detail === undefined ? {} : { detail: part.detail }) }));

  return {
    role: message.role,
    text,
    images,
    imageCount,
    isSynthetic:
      message.role === 'user' && (text.startsWith(SHELL_CONTEXT_PREFIX) || text.startsWith(LEGACY_MODE_NOTICE_PREFIX)),
  };
}
