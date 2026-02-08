import { z } from 'zod';
import { fetchWebPage } from '@qduc/web-fetch';
import type { ToolDefinition, CommandMessage } from './types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from './format-helpers.js';
import type { ISettingsService, ILoggingService } from '../services/service-interfaces.js';

const DEFAULT_MAX_CHARS = 10000;
const MAX_CHARS_LIMIT = 200000;

const webFetchSchema = z.object({
  url: z.string().describe('The URL of the web page to fetch.'),
  max_chars: z
    .number()
    .min(200)
    .max(MAX_CHARS_LIMIT)
    .default(DEFAULT_MAX_CHARS)
    .describe(`Maximum number of characters to return (default: ${DEFAULT_MAX_CHARS}).`),
  heading: z
    .array(z.union([z.string(), z.number()]))
    .default([])
    .describe('Optional: Array of headings (h1-h3) to retrieve content from.'),
  continuation_token: z
    .string()
    .nullable()
    .default(null)
    .describe('Optional: Token from previous response to fetch the next chunk of content.'),
});

export type WebFetchParams = z.infer<typeof webFetchSchema>;

/**
 * Format command message for display in the terminal
 */
export const formatWebFetchCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const url = args?.url ?? 'unknown url';
  const command = `web_fetch: "${url}"`;
  const output = getOutputText(item) || 'No results';
  const success = !output.startsWith('Error:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'web_fetch',
      toolArgs: args,
    }),
  ];
};

export const createWebFetchToolDefinition = (deps: {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
}): ToolDefinition<Partial<WebFetchParams>> => {
  const { loggingService } = deps;

  return {
    name: 'web_fetch',
    description:
      'Fetch a web page and convert its HTML content to Markdown format with intelligent content extraction.',
    parameters: webFetchSchema,
    needsApproval: () => false,
    execute: async (params) => {
      const { url, max_chars = DEFAULT_MAX_CHARS, heading: targetHeadings, continuation_token } = params;

      try {
        const result = await fetchWebPage({
          url,
          maxChars: max_chars,
          headings: targetHeadings,
          continuationToken: continuation_token ?? undefined,
        });

        let output = `Title: ${result.title}\nURL: ${result.url}\n\n`;
        if (result.toc) {
          output += `## Table of Contents\n\n${result.toc}\n\n---\n\n`;
        }
        output += result.markdown;

        if (result.continuationToken) {
          output += `\n\n**Note: Content truncated. Use continuation_token: "${result.continuationToken}" to fetch more.**`;
        }

        return output;
      } catch (error: any) {
        loggingService.error('Web fetch failed', {
          url,
          error: error.message || String(error),
        });
        return `Error: ${error.message || String(error)}`;
      }
    },
    formatCommandMessage: formatWebFetchCommandMessage,
  };
};
