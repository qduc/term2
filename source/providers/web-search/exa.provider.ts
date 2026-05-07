/**
 * Exa web search provider implementation.
 * Exa (formerly Metaphor) provides neural search and rich text extraction.
 *
 * API Documentation: https://docs.exa.ai/
 */

import { registerWebSearchProvider } from './registry.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchDeps } from './types.js';
import type { ISettingsService } from '../../services/service-interfaces.js';

/**
 * Exa API response structure (relevant fields only)
 */
interface ExaAPIResponse {
  results: Array<{
    title: string;
    url: string;
    score?: number;
    publishedDate?: string;
    text?: string;
    highlights?: string[];
    summary?: string;
  }>;
}

const EXA_API_URL = 'https://api.exa.ai/search';

async function searchExa(query: string, deps: WebSearchDeps): Promise<WebSearchResponse> {
  const { settingsService, loggingService } = deps;

  const apiKey = settingsService.get<string>('webSearch.exa.apiKey');
  if (!apiKey) {
    throw new Error(
      'Exa API key is not configured. ' + 'Set EXA_API_KEY environment variable or configure webSearch.exa.apiKey.',
    );
  }

  loggingService.debug('Executing Exa web search', { query });

  const response = await fetch(EXA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query: query,
      contents: {
        highlights: true,
      },
      numResults: 10,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    loggingService.error('Exa API error', {
      status: response.status,
      error: errorText,
    });
    throw new Error(`Exa API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as ExaAPIResponse;

  loggingService.debug('Exa search completed', {
    resultCount: data.results?.length || 0,
  });

  return {
    query: query,
    results: (data.results || []).map((r) => {
      // Create a concatenated content string from highlights, summary or text
      let content = '';
      if (Array.isArray(r.highlights) && r.highlights.length > 0) {
        content = r.highlights.join('\n...\n');
      } else if (r.summary) {
        content = r.summary;
      } else if (r.text) {
        content = r.text.substring(0, 1000);
      }

      return {
        title: r.title || r.url,
        url: r.url,
        content: content,
        score: r.score,
        publishedDate: r.publishedDate,
      };
    }),
  };
}

function isConfigured(deps: { settingsService: ISettingsService }): boolean {
  const apiKey = deps.settingsService.get<string>('webSearch.exa.apiKey');
  return !!apiKey;
}

// Create the Exa provider definition
const exaProvider: WebSearchProvider = {
  id: 'exa',
  label: 'Exa',
  search: searchExa,
  isConfigured,
  sensitiveSettingKeys: ['webSearch.exa.apiKey'],
};

// Register the Exa provider
registerWebSearchProvider(exaProvider);

// Export for testing purposes
export { exaProvider, searchExa, isConfigured as isExaConfigured };
