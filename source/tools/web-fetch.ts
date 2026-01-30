import { z } from 'zod';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { ToolDefinition, CommandMessage } from './types.js';
import {
    getOutputText,
    normalizeToolArguments,
    createBaseMessage,
    getCallIdFromItem,
} from './format-helpers.js';
import type {
    ISettingsService,
    ILoggingService,
} from '../services/service-interfaces.js';

const DEFAULT_MAX_CHARS = 10000;
const MAX_CHARS_LIMIT = 200000;
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MIN_READABILITY_LENGTH = 300;
const MIN_SELECTOR_LENGTH = 300;

const webFetchSchema = z.object({
    url: z.string().url().describe('The URL of the web page to fetch.'),
    max_chars: z.number().min(200).max(MAX_CHARS_LIMIT).optional().describe(`Maximum number of characters to return (default: ${DEFAULT_MAX_CHARS}).`),
    heading: z.array(z.union([z.string(), z.number()])).optional().describe('Optional: Array of headings (h1-h3) to retrieve content from.'),
    continuation_token: z.string().optional().describe('Optional: Token from previous response to fetch the next chunk of content.'),
});

export type WebFetchParams = z.infer<typeof webFetchSchema>;

// Content cache for continuation support
const contentCache = new Map<string, {
    markdown: string;
    offset: number;
    url: string;
    title: string;
    metadata: any;
    timestamp: number;
}>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of contentCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            contentCache.delete(key);
        }
    }
}, 60 * 1000).unref();

function generateCacheKey(url: string, type: string, value: any): string {
    return `${url}:${type}:${JSON.stringify(value)}:${Date.now()}`;
}

/**
 * Format command message for display in the terminal
 */
export const formatWebFetchCommandMessage = (
    item: any,
    index: number,
    toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const callId = getCallIdFromItem(item);
    const fallbackArgs =
        callId && toolCallArgumentsById.has(callId)
            ? toolCallArgumentsById.get(callId)
            : null;
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args =
        normalizeToolArguments(normalizedArgs) ??
        normalizeToolArguments(fallbackArgs) ??
        {};

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
}): ToolDefinition<WebFetchParams> => {
    const { loggingService } = deps;

    return {
        name: 'web_fetch',
        description: 'Fetch a web page and convert its HTML content to Markdown format with intelligent content extraction.',
        parameters: webFetchSchema,
        needsApproval: () => false,
        execute: async (params) => {
            const { url, max_chars = DEFAULT_MAX_CHARS, heading: targetHeadings, continuation_token } = params;

            try {
                if (continuation_token) {
                    return handleContinuation(continuation_token, max_chars);
                }

                if (!url) {
                    return 'Error: URL is required for initial fetch.';
                }

                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; Term2/1.0; +https://github.com/qduc/term2)',
                    },
                    signal: AbortSignal.timeout(15000),
                });

                if (!response.ok) {
                    return `Error: HTTP error! status: ${response.status} ${response.statusText}`;
                }

                const contentType = response.headers.get('content-type') || '';
                if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
                    // We'll still try to parse if it's unknown or looks like text
                    if (!contentType.includes('text') && !contentType.includes('json') && !contentType.includes('xml')) {
                        return `Error: Unsupported content type: ${contentType}`;
                    }
                }

                // Simplified reading without streaming for now, following project patterns
                // or use the streaming logic from reference if preferred.
                // Given the reference used streaming for size limits, I'll adapt a simplified version.

                const html = await response.text();
                if (html.length > MAX_BODY_SIZE) {
                  return `Error: Response body exceeds maximum size limit of ${MAX_BODY_SIZE / (1024 * 1024)} MB`;
                }

                const dom = new JSDOM(html, { url });
                const doc = dom.window.document;

                // Extraction strategies
                let extractedContent: any = null;
                let method = 'unknown';

                // Readability
                try {
                    const reader = new Readability(doc.cloneNode(true) as any);
                    const article = reader.parse();
                    if (article && (article.length || 0) > MIN_READABILITY_LENGTH) {
                        extractedContent = {
                            html: article.content,
                            title: article.title,
                            excerpt: article.excerpt,
                        };
                        method = 'readability';
                    }
                } catch (e) {
                    // Ignore readability errors
                }

                // Selector fallback
                if (!extractedContent) {
                    const selectors = ['main', 'article', '#content', '.content', '.main'];
                    for (const s of selectors) {
                        const el = doc.querySelector(s);
                        if (el && el.textContent?.trim().length! > MIN_SELECTOR_LENGTH) {
                            extractedContent = {
                                html: el.innerHTML,
                                title: doc.title,
                            };
                            method = `selector:${s}`;
                            break;
                        }
                    }
                }

                // Basic clean fallback
                if (!extractedContent) {
                    extractedContent = {
                        html: cleanHtml(html),
                        title: doc.title || 'Untitled',
                    };
                    method = 'basic-clean';
                }

                const allHeadings = extractHeadings(extractedContent.html);
                const fullToc = buildTOC(allHeadings);

                let filteredHtml = extractedContent.html;
                if (targetHeadings && targetHeadings.length > 0) {
                    const filterResult = filterContentByHeadings(extractedContent.html, allHeadings, targetHeadings);
                    if (!filterResult.error && filterResult.filtered) {
                        filteredHtml = filterResult.html;
                    }
                }

                const turndownService = new TurndownService({
                    headingStyle: 'atx',
                    codeBlockStyle: 'fenced',
                });

                let markdown = turndownService.turndown(filteredHtml);

                const truncationResult = truncateMarkdown(markdown, max_chars, 0);
                markdown = truncationResult.markdown;

                let finalContinuationToken: string | null = null;
                if (truncationResult.hasMore && allHeadings.length === 0) {
                     finalContinuationToken = generateCacheKey(url, 'continuation', truncationResult.nextOffset);
                     contentCache.set(finalContinuationToken, {
                         markdown: turndownService.turndown(extractedContent.html),
                         offset: truncationResult.nextOffset,
                         url,
                         title: extractedContent.title,
                         metadata: { method },
                         timestamp: Date.now()
                     });
                }

                let result = `Title: ${extractedContent.title}\nURL: ${url}\n\n`;
                if (fullToc) {
                    result += `## Table of Contents\n\n${fullToc}\n\n---\n\n`;
                }
                result += markdown;

                if (finalContinuationToken) {
                    result += `\n\n**Note: Content truncated. Use continuation_token: "${finalContinuationToken}" to fetch more.**`;
                }

                return result;

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

function cleanHtml(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function extractHeadings(html: string) {
    const headingRegex = /<h([1-3])[^>]*>(.*?)<\/h\1>/gi;
    const headings: any[] = [];
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
        const text = match[2].replace(/<[^>]*>/g, '').trim();
        if (text) {
            headings.push({ level: parseInt(match[1]), text, position: match.index });
        }
    }
    return headings;
}

function buildTOC(headings: any[]) {
    if (headings.length === 0) return null;
    return headings.map(h => `${'  '.repeat(h.level - 1)}- ${h.text}`).join('\n');
}

function filterContentByHeadings(html: string, headings: any[], targets: (string | number)[]) {
    let combinedHtml = '';
    let filtered = false;
    for (const target of targets) {
        let idx = -1;
        if (typeof target === 'number') {
            idx = target - 1;
        } else {
            const lower = target.toLowerCase();
            idx = headings.findIndex(h => h.text.toLowerCase().includes(lower));
        }

        if (idx >= 0 && idx < headings.length) {
            filtered = true;
            const start = headings[idx].position;
            let end = html.length;
            for (let i = idx + 1; i < headings.length; i++) {
                if (headings[i].level <= headings[idx].level) {
                    end = headings[i].position;
                    break;
                }
            }
            combinedHtml += html.substring(start, end) + '\n\n';
        }
    }
    return { html: combinedHtml, filtered, error: filtered ? null : 'No matching headings found' };
}

function truncateMarkdown(markdown: string, maxChars: number, offset: number) {
    const start = offset;
    if (start >= markdown.length) return { markdown: '', hasMore: false, nextOffset: start };

    if (markdown.length - start <= maxChars) {
        return { markdown: markdown.substring(start), hasMore: false, nextOffset: markdown.length };
    }

    let end = start + maxChars;
    const lastNewline = markdown.lastIndexOf('\n', end);
    if (lastNewline > start + maxChars * 0.8) {
        end = lastNewline;
    }

    return {
        markdown: markdown.substring(start, end).trim() + '\n\n[... Truncated ...]',
        hasMore: true,
        nextOffset: end,
        originalLength: markdown.length
    };
}

function handleContinuation(token: string, maxChars: number) {
    const cached = contentCache.get(token);
    if (!cached) return 'Error: Continuation token expired or invalid.';

    const result = truncateMarkdown(cached.markdown, maxChars, cached.offset);
    let nextToken: string | null = null;
    if (result.hasMore) {
        nextToken = generateCacheKey(cached.url, 'continuation', result.nextOffset);
        contentCache.set(nextToken, { ...cached, offset: result.nextOffset, timestamp: Date.now() });
    }

    let response = result.markdown;
    if (nextToken) {
        response += `\n\n**Note: Content truncated. Use continuation_token: "${nextToken}" to fetch more.**`;
    }
    return response;
}
