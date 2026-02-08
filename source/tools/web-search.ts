/**
 * Web search tool for the terminal assistant.
 * Uses pluggable web search providers (default: Tavily) to fetch current information from the web.
 */

import { z } from 'zod';
import type { ToolDefinition, CommandMessage } from './types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from './format-helpers.js';
import { getConfiguredWebSearchProvider, type WebSearchResponse } from '../providers/web-search/index.js';
import type { ISettingsService, ILoggingService } from '../services/service-interfaces.js';

const webSearchSchema = z.object({
  query: z.string().min(1).describe('The search query to look up on the web.'),
});

export type WebSearchParams = z.infer<typeof webSearchSchema>;

/**
 * Convert web search results to a markdown-formatted string
 */
export function formatResultsAsMarkdown(response: WebSearchResponse): string {
  const parts: string[] = [];

  // Add answer box if available (Tavily's synthesized answer)
  if (response.answerBox) {
    parts.push('## Answer\n');
    parts.push(response.answerBox);
    parts.push('\n');
  }

  // Add search results
  if (response.results.length > 0) {
    parts.push('## Search Results\n');

    response.results.forEach((result, index) => {
      parts.push(`### ${index + 1}. ${result.title}\n`);
      parts.push(`**URL:** ${result.url}\n`);
      if (result.publishedDate) {
        parts.push(`**Published:** ${result.publishedDate}\n`);
      }
      parts.push(`\n${result.content}\n`);
      parts.push('\n---\n');
    });
  } else {
    parts.push('No results found for this query.\n');
  }

  return parts.join('\n');
}

/**
 * Format command message for display in the terminal
 */
export const formatWebSearchCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const query = args?.query ?? 'unknown query';
  const command = `web_search: "${query}"`;
  const output = getOutputText(item) || 'No results';
  const success = !output.startsWith('Error:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'web_search',
      toolArgs: args,
    }),
  ];
};

/**
 * Factory function to create the web_search tool definition
 */
export const createWebSearchToolDefinition = (deps: {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
}): ToolDefinition<WebSearchParams> => {
  const { settingsService, loggingService } = deps;

  return {
    name: 'web_search',
    description:
      'Search the web for current information. Use this when you need up-to-date information ' +
      'that may not be in your training data, such as recent news, current events, ' +
      'documentation updates, or any time-sensitive information.',
    parameters: webSearchSchema,
    needsApproval: () => false, // Web search is read-only, safe operation
    execute: async (params) => {
      const { query } = params;

      try {
        const provider = getConfiguredWebSearchProvider({ settingsService });

        if (!provider) {
          return 'Error: No web search provider is configured.';
        }

        if (!provider.isConfigured({ settingsService })) {
          return (
            `Error: Web search provider '${provider.id}' is not properly configured. ` +
            `Please set the required API key (e.g., TAVILY_API_KEY environment variable).`
          );
        }

        const response = await provider.search(query, {
          settingsService,
          loggingService,
        });

        return formatResultsAsMarkdown(response);
      } catch (error: any) {
        loggingService.error('Web search failed', {
          query,
          error: error.message || String(error),
        });
        return `Error: ${error.message || String(error)}`;
      }
    },
    formatCommandMessage: formatWebSearchCommandMessage,
  };
};
