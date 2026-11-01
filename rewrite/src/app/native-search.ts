/** App-owned read-only search capability. Session registers it but owns no file access. */
import { z } from 'zod';
import type { Tool, Workspace } from '../tools/index.js';
import type { DirectBinding } from '../session/facade-types.js';
import { nativeSearchScope, withNativeCatalogue } from './native-catalogue.js';

const inputSchema = z
  .object({
    query: z.string().min(1),
    kind: z.enum(['user', 'assistant', 'system', 'tool', 'reasoning', 'subagent', 'approval', 'notice']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

/** Bind directory and authority once; the model cannot supply paths or workspace filters. */
export function createNativeSearchTool(directory: string, workspace: Workspace, binding?: DirectBinding): Tool {
  const scope = nativeSearchScope(workspace, binding);
  return {
    spec: {
      name: 'session_search',
      description:
        'Search visible native conversation transcripts in this authorized workspace. Whitespace-separated terms are literal OR alternatives, not MATCH syntax. Optional kind filters content. Returns total matched identities and up to 50 native log snippets (500 characters each). No session browser/open/read methods are provided.',
      inputSchema: z.toJSONSchema(inputSchema),
    },
    parse: (raw) => inputSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(raw, context) {
      context.signal.throwIfAborted();
      if (context.workspace.target !== workspace.target || context.workspace.root !== workspace.root)
        throw new Error('Native search workspace authority changed');
      const { query, kind, limit } = inputSchema.parse(raw);
      const result = withNativeCatalogue(directory, (catalogue) => catalogue.search(scope, query, kind, limit));
      return { output: JSON.stringify(result), isError: false };
    },
  };
}
