import { z } from 'zod';
import { writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';
import type { ISettingsService, ILoggingService } from '../../services/service-interfaces.js';

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
    .describe(`Maximum number of characters to return (default: ${DEFAULT_MAX_CHARS}).`),
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
}): ToolDefinition<Partial<WebFetchParams>> => {
  const { loggingService } = deps;

  return {
    name: 'web_fetch',
    description:
      'Fetch a web page and convert its HTML content to Markdown format with intelligent content extraction. When content exceeds max_chars, the full content is saved to a temporary file for searching.',
    parameters: webFetchSchema,
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
          const safeName = (url ?? 'unknown').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
          const timestamp = Date.now();
          const rand = Math.random().toString(36).slice(2, 8);
          const tmpDir = os.tmpdir();
          tempFilePath = path.join(tmpDir, `term2-web-fetch-${safeName}-${timestamp}-${rand}.md`);
          await writeFile(tempFilePath, result.markdown, 'utf-8');

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
          output += `\n\n**Full content saved to temp file: \`${tempFilePath}\`**\nThe full content has been saved for reference. You can use grep, read_file (with limited line range) on this file to find specific information.`;
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
