import { getTrimConfig, trimOutput } from './output-trim.js';
import { countFileLines, formatFullOutputSavedNote, saveOutputArtifact } from '../shell/shell-output.js';

const tryParseJson = (value: string): unknown | null => {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const trimStringValue = (value: string, maxLines?: number, maxCharacters?: number): string => {
  if (!value) {
    return value;
  }
  return trimOutput(value, maxLines, maxCharacters);
};

const trimJsonStrings = (value: unknown, maxLines?: number, maxCharacters?: number): unknown => {
  if (typeof value === 'string') {
    return trimStringValue(value, maxLines, maxCharacters);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => trimJsonStrings(entry, maxLines, maxCharacters));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = trimJsonStrings(entry, maxLines, maxCharacters);
    }
    return next;
  }

  return value;
};

/**
 * True for a multimodal tool result: a non-empty array whose every entry is an
 * object carrying a string `type` discriminator, the shape the provider
 * converters know how to serialize.
 */
const isContentPartArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (part) => typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string',
  );

export const trimToolOutput = (output: unknown, maxLines?: number, maxCharacters?: number): unknown => {
  if (typeof output !== 'string') {
    // A structured content-part result (read_file returns
    // `[{type:'text'},{type:'image'},...]` for images) is not text to be
    // trimmed. Return it unmodified — trimming string leaves would truncate an
    // image's base64 `data` and corrupt it, and coercing via String() would
    // flatten the array to "[object Object],[object Object]".
    //
    // Only content-part arrays get this exemption. Any other array keeps the
    // old String() coercion, so a tool returning arbitrary objects does not
    // silently escape the size limit or reach a converter that rejects it.
    if (isContentPartArray(output)) {
      return output;
    }
    return String(output ?? '');
  }

  const parsed = tryParseJson(output);
  if (parsed !== null) {
    const trimmed = trimJsonStrings(parsed, maxLines, maxCharacters);
    try {
      return JSON.stringify(trimmed);
    } catch {
      return trimStringValue(output, maxLines, maxCharacters);
    }
  }

  return trimStringValue(output, maxLines, maxCharacters);
};

/**
 * Bound a tool result at the point it enters model context.
 *
 * `trimToolOutput` bounds each string of a JSON result separately, so a result
 * with many fields can still exceed the limit in total, and it does not save
 * what it cuts. Whenever this boundary cuts anything, the untrimmed output is
 * saved to a file and the standard `Full output saved to` note is appended; if
 * the text is still over `maxCharacters` with the note, the whole text is cut by
 * size (start and end kept). The cut never depends on what the text contains.
 * Content-part arrays (images) are returned unchanged, as by `trimToolOutput`.
 */
export const boundModelToolOutput = async (output: unknown, maxCharacters?: number): Promise<unknown> => {
  const trimmed = trimToolOutput(output, undefined, maxCharacters);
  if (typeof trimmed !== 'string') return trimmed;
  const limit = maxCharacters ?? getTrimConfig().maxCharacters;
  // The same serialization with no limits: a difference from it means something was cut,
  // not merely re-serialized (a JSON result is always re-stringified).
  const untrimmed = trimToolOutput(output, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY) as string;
  if (trimmed === untrimmed && trimmed.length <= limit) return trimmed;

  const full = typeof output === 'string' ? output : untrimmed;
  let note: string;
  try {
    note = formatFullOutputSavedNote(await saveOutputArtifact(full), countFileLines(full));
  } catch {
    note = 'Full output could not be saved; the omitted text is unavailable.';
  }
  if (trimmed.length + 1 + note.length <= limit) return `${trimmed}\n${note}`;

  const omitted = (kept: number) => `\n... [${trimmed.length - kept} characters trimmed] ...\n`;
  // Reserve room for the marker at its widest, so the result stays within the limit.
  const budget = Math.max(0, limit - note.length - 1 - omitted(0).length);
  let head = trimmed.slice(0, Math.ceil(budget / 2));
  let tail = trimmed.slice(trimmed.length - Math.floor(budget / 2));
  // Do not split a UTF-16 surrogate pair at either cut.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}${omitted(head.length + tail.length)}${tail}\n${note}`;
};
