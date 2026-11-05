import { getTrimConfig } from './output-trim.js';
import { formatFullOutputSavedNote, saveOutputArtifact } from '../shell/shell-output.js';

/** Default byte cap for tool results that enter model context. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 40_000;

/**
 * True when `run_code` made this call from inside a script.
 *
 * `run_code` sets `scripted` on the invocation context it passes to nested
 * tools. Tools consult it to decide whether a context-protection cap applies:
 * a scripted result goes to the script, not into model context.
 */
export function isScriptedToolCall(context: unknown): boolean {
  return !!context && typeof context === 'object' && (context as { scripted?: unknown }).scripted === true;
}

/**
 * Resolves the result byte cap for a call, honouring the scripted boundary.
 *
 * An explicit override always wins; otherwise a scripted call gets the larger
 * scripted cap and a direct call gets the context default.
 */
export function resolveResultMaxBytesForCall(context: unknown, override?: number): number {
  return resolveToolResultMaxBytes(
    override ?? (isScriptedToolCall(context) ? SCRIPTED_TOOL_RESULT_MAX_BYTES : undefined),
  );
}

/**
 * Byte cap for a result delivered to a script instead of to model context.
 *
 * Matches `RUN_CODE_LIMITS.maxResultChars`, which bounds the same value one
 * layer out; duplicated as a literal to keep this module free of a dependency
 * on the tool layer.
 */
export const SCRIPTED_TOOL_RESULT_MAX_BYTES = 100_000;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * code unit. Returns the original string when it already fits.
 */
export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; byteLength: number } {
  const byteLength = utf8ByteLength(text);
  if (byteLength <= maxBytes) {
    return { text, truncated: false, byteLength };
  }

  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, buf.length);
  // Walk back over UTF-8 continuation bytes (10xxxxxx) so we do not cut mid-character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    text: buf.subarray(0, end).toString('utf8'),
    truncated: true,
    byteLength,
  };
}

/**
 * Heuristic binary detection: NUL bytes or a high share of non-text control
 * bytes in the sample. Used to refuse dumping opaque binary into context.
 */
export function looksLikeBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i]!;
    if (byte === 0) {
      return true;
    }
    // Allow common whitespace control chars; count other C0 controls and DEL.
    if (byte < 7 || (byte > 13 && byte < 32) || byte === 127) {
      nonText++;
    }
  }
  return nonText / sample.length > 0.3;
}

export function resolveToolResultMaxBytes(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  // Stay aligned with the existing character trim default unless a caller overrides.
  return getTrimConfig().maxCharacters || DEFAULT_TOOL_RESULT_MAX_BYTES;
}

export interface BoundToolResultTextParams {
  /** Text that would enter model context if it fits. */
  fullText: string;
  /** Optional override for the byte cap. */
  maxBytes?: number;
  /**
   * Full payload written to the artifact when truncated. Defaults to `fullText`.
   * Use when the on-wire text includes headers that should not replace the
   * retrievable body, or when the artifact should carry richer metadata.
   */
  artifactContents?: string;
}

export interface BoundToolResultTextResult {
  text: string;
  truncated: boolean;
  artifactPath?: string;
  byteLength: number;
}

/**
 * Bound a tool result for model context. Over the cap, spool the full payload
 * and append the shell note shape so the agent can read the path back.
 */
export async function boundToolResultText(params: BoundToolResultTextParams): Promise<BoundToolResultTextResult> {
  const maxBytes = resolveToolResultMaxBytes(params.maxBytes);
  const byteLength = utf8ByteLength(params.fullText);
  if (byteLength <= maxBytes) {
    return { text: params.fullText, truncated: false, byteLength };
  }

  // Reserve room for the note line so the combined result stays near the cap.
  const noteReserve = 120;
  const bodyBudget = Math.max(256, maxBytes - noteReserve);
  const { text: truncatedBody } = truncateToUtf8Bytes(params.fullText, bodyBudget);
  const artifactPath = await saveOutputArtifact(params.artifactContents ?? params.fullText);
  const note = formatFullOutputSavedNote(artifactPath);
  return {
    text: `${truncatedBody}\n${note}`,
    truncated: true,
    artifactPath,
    byteLength,
  };
}
