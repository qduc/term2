import type { ChainedWireProtocol } from './chained-wire-state.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAdditionalTools = (value: unknown): value is RecordValue =>
  isRecord(value) && value.type === 'additional_tools' && value.role === 'developer';

const isDeveloperMessage = (value: unknown): value is RecordValue =>
  isRecord(value) && value.type === 'message' && value.role === 'developer';

const isProviderOutput = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type === 'message') return value.role === 'assistant';
  return (
    value.type === 'reasoning' ||
    value.type === 'function_call' ||
    value.type === 'local_shell_call' ||
    value.type === 'tool_search_call' ||
    value.type === 'custom_tool_call' ||
    value.type === 'web_search_call'
  );
};

/**
 * Item types whose server-assigned `id` field is stripped during output
 * normalization so that replayed items in a subsequent request match the
 * stored canonical form.
 */
const REPLAY_ITEM_TYPES_WITHOUT_IDS = new Set([
  'message',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'custom_tool_call',
  'web_search_call',
]);

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

/**
 * Luna (Responses-Lite) wire protocol for the chained-wire state machine.
 *
 * Encapsulates all Luna-specific behaviour that was previously inlined in
 * `ResponsesLiteWireState`:
 *
 * - Input access and `previous_response_id` extraction from request data.
 * - Fingerprint exclusions (`input`, `previous_response_id`, `client_metadata`,
 *   `generate`).
 * - Reusable prefix extraction (`additional_tools` and an optional trailing
 *   developer `message`).
 * - Replay-ID normalisation (stripping server `id` from output items).
 */
export class LunaResponsesLiteWireProtocol implements ChainedWireProtocol {
  // -----------------------------------------------------------------------
  // ChainedWireProtocol implementation
  // -----------------------------------------------------------------------

  getInput(requestData: RecordValue): unknown[] {
    return Array.isArray(requestData.input) ? requestData.input : [];
  }

  getPreviousResponseId(requestData: RecordValue): string | undefined {
    return typeof requestData.previous_response_id === 'string' && requestData.previous_response_id.length > 0
      ? requestData.previous_response_id
      : undefined;
  }

  getFingerprint(requestData: RecordValue, input: unknown[]): string {
    return JSON.stringify({
      request: this.#getComparableRequest(requestData),
      prefix: this.getPrefix(input),
    });
  }

  getPrefix(input: unknown[]): unknown[] {
    if (!isAdditionalTools(input[0])) {
      return [];
    }

    const prefix = [input[0]];
    if (isDeveloperMessage(input[1])) {
      prefix.push(input[1]);
    }
    return prefix;
  }

  getContinuationDelta(input: unknown[]): unknown[] | null {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      if (isProviderOutput(input[index])) return input.slice(index + 1);
    }
    return null;
  }

  normalizeOutputItems(items: unknown[]): unknown[] {
    return items.map((item) => {
      if (!isRecord(item) || typeof item.type !== 'string' || !REPLAY_ITEM_TYPES_WITHOUT_IDS.has(item.type)) {
        return item;
      }

      const { id: _id, ...withoutId } = item;
      return withoutId;
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Returns a version of `requestData` with unstable fields removed so the
   * fingerprint stays stable across conversation turns.
   */
  #getComparableRequest(requestData: RecordValue): RecordValue {
    const {
      input: _input,
      previous_response_id: _previousResponseId,
      client_metadata: _clientMetadata,
      generate: _generate,
      ...rest
    } = requestData;
    return rest;
  }
}

// ---------------------------------------------------------------------------
// Request projection
// ---------------------------------------------------------------------------

/** The only built-in OpenAI model that takes tools and instructions as conversation input. */
export const NATIVE_CONVERSATION_INPUT_MODEL = 'gpt-6-luna';

/**
 * Rewrite a classic Responses request body into native conversation input, in
 * place: tools and instructions become an initial developer prefix, and the
 * requested reasoning effort becomes a trailing `configuration_update`.
 *
 * The model is read from the finished body, so an extra-body model override
 * that leaves the native model keeps the classic format.
 */
export function applyNativeConversationInput(body: any): void {
  if (body.model !== NATIVE_CONVERSATION_INPUT_MODEL) return;
  const prefix: unknown[] = [];
  // Core continuity clears the anchor when instructions or tools change.
  // A chained continuation inherits this prefix instead of accumulating it.
  if (!body.previous_response_id) {
    if (body.tools?.length) prefix.push({ type: 'additional_tools', role: 'developer', tools: body.tools });
    if (body.instructions) {
      prefix.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: body.instructions }] });
    }
  }
  const input = Array.isArray(body.input) ? body.input : [{ type: 'message', role: 'user', content: body.input }];
  body.input = [...prefix, ...input];
  if (body.reasoning?.effort !== undefined) {
    body.input.push({ type: 'configuration_update', reasoning: { effort: body.reasoning.effort } });
  }
  delete body.tools;
  delete body.instructions;
}
