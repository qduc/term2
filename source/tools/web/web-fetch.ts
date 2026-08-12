import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';
import type { ISettingsService, ILoggingService } from '../../services/service-interfaces.js';
import { boundToolResultText } from '../../utils/output/bound-tool-result.js';
import { formatFullOutputSavedNote, saveOutputArtifact } from '../../utils/shell/shell-output.js';

const WEB_FETCH_DESCRIPTION =
  'Fetch a web page and convert its HTML content to Markdown. ' +
  'Use this when you need the full content of a specific URL referenced by web_search or the user. ' +
  'Do NOT use this for broad queries; use web_search. ' +
  'Returns the page title, URL, table of contents, and extracted Markdown. ' +
  'Initial fetches are truncated to max_chars; the full content is saved to a temporary file when exceeded ' +
  '(look for "Full output saved to" and read that path when you need more).';

const DEFAULT_MAX_CHARS = 10000;
const MAX_CHARS_LIMIT = 200000;

const webFetchSchema = z.object({
  url: z.string().describe('The URL of the web page to fetch.'),
  max_chars: z
    .number()
    .min(200)
    .max(MAX_CHARS_LIMIT)
    .optional()
    .default(DEFAULT_MAX_CHARS)
    .describe('Maximum number of characters to return.'),
  heading: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .default([])
    .describe('Optional: Array of headings (h1-h3) to retrieve content from.'),
  continuation_token: z
    .string()
    .optional()
    .describe('Optional: Token from previous response to fetch the next chunk of content.'),
});

export type WebFetchParams = z.infer<typeof webFetchSchema>;

/**
 * Format command message for display in the terminal
 */
export const formatWebFetchCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
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
}): ToolDefinition<typeof webFetchSchema> => {
  const { loggingService } = deps;

  return {
    name: 'web_fetch',
    description: WEB_FETCH_DESCRIPTION,
    parameters: webFetchSchema,
    parallelSafe: true,
    needsApproval: () => false,
    execute: async (params) => {
      const { url, max_chars = DEFAULT_MAX_CHARS, heading: targetHeadings, continuation_token } = params;

      try {
        const { fetchWebPage } = await import('@qduc/web-fetch');
        // For initial fetches, get as much content as the library can return.
        // For continuation requests, pass the user's max_chars through unchanged.
        const isContinuation = !!continuation_token;
        const result = await fetchWebPage({
          url,
          maxChars: isContinuation ? max_chars : MAX_CHARS_LIMIT,
          headings: targetHeadings,
          continuationToken: continuation_token ?? undefined,
        });

        let displayMarkdown = result.markdown;
        let tempFilePath: string | null = null;

        // For initial fetches, if content exceeds the user's requested max, save full to temp file
        if (!isContinuation && result.markdown.length > max_chars) {
          tempFilePath = await saveOutputArtifact(result.markdown, { filenamePrefix: 'web-fetch' });

          // Truncate the displayed markdown at a clean boundary near max_chars
          const truncated = result.markdown.slice(0, max_chars);
          const lastNewline = truncated.lastIndexOf('\n');
          displayMarkdown = lastNewline > max_chars * 0.8 ? truncated.slice(0, lastNewline) : truncated;
          displayMarkdown += `\n\n[... Content truncated at ${max_chars} characters for display ...]`;
        }

        let output = `Title: ${result.title}\nURL: ${result.url}\n\n`;
        if (result.toc) {
          output += `## Table of Contents\n\n${result.toc}\n\n---\n\n`;
        }
        output += displayMarkdown;

        if (result.continuationToken) {
          output += `\n\n**Note: Content still truncated. Use continuation_token: "${result.continuationToken}" to fetch more.**`;
        }

        if (tempFilePath) {
          output += `\n${formatFullOutputSavedNote(tempFilePath)}`;
        }

        // Final hard bound so even max_chars near the upper limit cannot blow context alone.
        const bounded = await boundToolResultText({ fullText: output });
        return bounded.text;
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
