/**
 * Puts MCP server problems in front of the user.
 *
 * Servers connect in the background after launch, so a failure or a required
 * login lands well after the first render. Before this hook those notices went
 * only to `logger.warn` — i.e. to a log file — which meant a misconfigured or
 * unauthenticated server failed completely silently in the UI, with the remedy
 * text written somewhere nobody looks.
 */
import { useEffect, useRef } from 'react';
import type { McpConnectionManager } from '../services/mcp/mcp-connection-manager.js';
import { formatMcpNotice, isActionableMcpState } from '../services/mcp/mcp-status.js';
import type { McpServerState } from '../services/mcp/mcp-tool-source.js';

export interface UseMcpNoticesOptions {
  /** Null when this session configured no MCP servers. */
  manager: McpConnectionManager | null;
  /** Config-load problems (bad JSON, dropped clashes) gathered before mount. */
  startupNotices?: readonly string[];
  addSystemMessage: (text: string) => void;
}

export const useMcpNotices = ({ manager, startupNotices, addSystemMessage }: UseMcpNoticesOptions): void => {
  // Announced state per server, so a catalog rebuild (tools/list_changed fires
  // one on every refresh) never re-announces a problem the user already saw.
  const announced = useRef(new Map<string, McpServerState>());
  const flushedStartup = useRef(false);

  useEffect(() => {
    if (flushedStartup.current || !startupNotices?.length) return;
    flushedStartup.current = true;
    for (const notice of startupNotices) addSystemMessage(`MCP: ${notice}`);
  }, [startupNotices, addSystemMessage]);

  useEffect(() => {
    if (!manager) return;
    const report = () => {
      for (const server of manager.snapshot()) {
        const seen = announced.current.get(server.name);
        if (seen === server.state) continue;
        announced.current.set(server.name, server.state);
        // Recovery is silent: reaching `ready` is what the user asked for, and
        // only the states they must act on are worth an interruption.
        const notice = isActionableMcpState(server.state) ? formatMcpNotice(server) : undefined;
        if (notice) addSystemMessage(notice);
      }
    };
    // Servers may already have settled between composition and mount, so the
    // current snapshot is reported before subscribing rather than waiting for
    // the next change that might never come.
    report();
    return manager.onCatalogChanged(report);
  }, [manager, addSystemMessage]);
};
