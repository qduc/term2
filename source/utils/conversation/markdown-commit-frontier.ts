import { marked } from 'marked';

type MarkdownToken = {
  type?: string;
  raw?: string;
};

const hasGlobalDefinitions = (tokens: ReturnType<typeof marked.lexer>): boolean =>
  Object.keys(tokens.links ?? {}).length > 0;

const hasPotentialReferenceSyntax = (source: string): boolean => /!?\[[^\]\n]+\](?:\[[^\]\n]*\])?(?!\()/.test(source);

/**
 * Returns the absolute source offset before the final top-level Markdown
 * block. Earlier siblings are structurally stable; the final block remains
 * mutable because later stream content may extend or reinterpret it.
 *
 * The AST is used only to choose an offset. Committed text is always sliced
 * from the authoritative source so whitespace and source spelling are kept
 * exactly as received.
 */
export const findMarkdownCommitOffset = (source: string, committedOffset = 0): number => {
  if (committedOffset < 0 || committedOffset > source.length) {
    return committedOffset;
  }

  const remaining = source.slice(committedOffset);
  if (!remaining.includes('\n')) {
    return committedOffset;
  }

  const tokens = marked.lexer(remaining);
  if (hasPotentialReferenceSyntax(source) || hasGlobalDefinitions(tokens)) {
    return committedOffset;
  }

  let finalBlockIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== 'space') {
      finalBlockIndex = index;
      break;
    }
  }

  if (finalBlockIndex <= 0) {
    return committedOffset;
  }

  let relativeOffset = 0;
  for (let index = 0; index < finalBlockIndex; index += 1) {
    const token = tokens[index] as MarkdownToken;
    if (typeof token.raw !== 'string') {
      return committedOffset;
    }
    relativeOffset += token.raw.length;
  }

  const nextOffset = committedOffset + relativeOffset;
  return source.slice(committedOffset, nextOffset).trim() ? nextOffset : committedOffset;
};
