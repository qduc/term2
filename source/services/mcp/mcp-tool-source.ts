/**
 * Contract between the MCP connection layer (`source/services/mcp/`) and its
 * only consumer, the `run_code` script surface. MCP tools are never direct
 * model tools; see docs/plans/mcp-code-mode.md, Decision 1.
 *
 * This file is types only. Implementations must not widen it without updating
 * both sides and the plan.
 */
import type { JsonSchemaObject } from '../../tools/types.js';

/** Where a server's configuration came from. Drives sandboxing (plan Decision 4). */
export type McpServerProvenance = 'user' | 'project';

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

/**
 * `needs-auth` is a distinct resting state, not a failure: the server answered
 * correctly and asked for an OAuth login that only the user can start
 * (plan decision D1). `error` carries the `/mcp-login` instruction.
 */
export type McpServerState = 'connecting' | 'ready' | 'failed' | 'needs-auth';

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One tool exactly as the server listed it (all `tools/list` pages merged). */
export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  /** Server-supplied hints. Untrusted: never used to bypass approval. */
  readonly annotations?: McpToolAnnotations;
}

export interface McpServerSnapshot {
  /** Config key, unique across merged user + project config. */
  readonly name: string;
  readonly provenance: McpServerProvenance;
  readonly transport: McpTransportKind;
  readonly state: McpServerState;
  /**
   * Human-readable reason when `state` is `failed` or `needs-auth`, including
   * sandbox override hints and the `/mcp-login` instruction.
   */
  readonly error?: string;
  /** Empty unless `state === 'ready'`. */
  readonly tools: readonly McpToolDescriptor[];
}

export interface McpCallResult {
  /** MCP `CallToolResult.content` blocks, unmodified. */
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
  /** Application-level tool failure reported by the server. */
  readonly isError: boolean;
}

export type McpCallErrorCode =
  | 'unknown_server'
  | 'unknown_tool'
  | 'server_unavailable'
  | 'timeout'
  | 'aborted'
  | 'protocol';

/** Rejection type for {@link McpToolSource.callTool}. Transport/protocol failures only. */
export class McpCallError extends Error {
  constructor(readonly code: McpCallErrorCode, message: string) {
    super(message);
    this.name = 'McpCallError';
  }
}

export interface McpCallOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface McpToolSource {
  /**
   * Current catalog. Returns the same array instance until the catalog changes,
   * so callers can cheaply detect change by identity.
   */
  snapshot(): readonly McpServerSnapshot[];
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallResult>;
  /** Fires after `snapshot()` would return a new array. Returns an unsubscribe function. */
  onCatalogChanged(listener: () => void): () => void;
}
