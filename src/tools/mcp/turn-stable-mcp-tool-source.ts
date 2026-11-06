import type { McpCallOptions, McpCallResult, McpServerSnapshot, McpToolSource } from './mcp-tool-source.js';

/**
 * Keeps the catalog used to describe an agent stable until the caller starts
 * the next turn. Calls deliberately remain live so a server can recover while
 * a prompt is in flight.
 */
export class TurnStableMcpToolSource implements McpToolSource {
  private catalog: readonly McpServerSnapshot[];
  private pending = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly live: McpToolSource) {
    this.catalog = live.snapshot();
    this.unsubscribe = live.onCatalogChanged(() => {
      this.pending = true;
    });
  }

  beginTurn(): void {
    if (this.pending) {
      this.catalog = this.live.snapshot();
      this.pending = false;
    }
  }

  snapshot(): readonly McpServerSnapshot[] {
    return this.catalog;
  }

  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<McpCallResult> {
    return this.live.callTool(server, tool, args, options);
  }

  onCatalogChanged(listener: () => void): () => void {
    return this.live.onCatalogChanged(listener);
  }

  dispose(): void {
    this.unsubscribe();
  }
}
