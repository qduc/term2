import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import type { SessionBrowser } from '../../services/conversation/session-browser.js';
import { boundedJsonFailure, fitsSerializedText } from '../../utils/output/bounded-json.js';
import { resolveToolResultMaxBytes } from '../../utils/output/bound-tool-result.js';
import {
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
  createBaseMessage,
} from '../format-helpers.js';

const maxChars = z.number().int().min(512).max(12_000).optional();
const limit = z.number().int().min(1).max(50).optional();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export function createSessionBrowserToolDefinitions(browser: SessionBrowser): ToolDefinition[] {
  return [
    definition(
      'session_list',
      'List prior locally persisted sessions for the current project.',
      z.object({ limit, maxChars }).strict(),
      (params) => browser.list(params),
    ),
    definition(
      'session_search',
      'Search prior locally persisted session transcripts for the current project.',
      z.object({ query: z.string().refine((value) => /\S/.test(value)), limit, maxChars }).strict(),
      (params) => browser.search(params),
    ),
    definition(
      'session_read',
      'Read a prior local session transcript progressively by cursor.',
      z.object({ id, cursor: z.string().optional(), limit, maxChars }).strict(),
      (params) => browser.read(params),
    ),
  ];
}

function definition<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  parameters: S,
  execute: (params: z.infer<S>) => unknown,
): ToolDefinition<S> {
  return {
    name,
    description,
    parameters,
    preserveSerializedOutput: true,
    needsApproval: () => false,
    execute: async (params) => {
      const result = JSON.stringify(execute(params));
      const budget = (params as { maxChars?: number }).maxChars ?? 12_000;
      return fitsSerializedText(result, { maxChars: budget, maxBytes: resolveToolResultMaxBytes() })
        ? result
        : boundedJsonFailure({ maxChars: budget, maxBytes: resolveToolResultMaxBytes() });
    },
    formatCommandMessage: (item, index, calls) => {
      const callId = getCallIdFromItem(item);
      const args =
        normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
        (callId ? normalizeToolArguments(calls.get(callId)) : {}) ??
        {};
      const output = getOutputText(item);
      return [
        createBaseMessage(item, index, 0, false, {
          command: `${name}: ${String(args.id ?? args.query ?? '')}`,
          output,
          success: isSuccessOutput(output),
          toolName: name,
          toolArgs: args,
        }),
      ];
    },
  };
}
