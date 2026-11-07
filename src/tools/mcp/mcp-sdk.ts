/**
 * The MCP client SDK, loaded when a server first connects or a login starts.
 * Importing it cost every start ~25 ms, and most starts configure no server.
 *
 * An SDK error cannot exist before the SDK loads, so a classifier that finds
 * `loadedMcpSdk()` undefined can treat the error as not coming from the SDK.
 */
import type * as McpClientSdk from '@modelcontextprotocol/client';
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export type McpSdk = typeof McpClientSdk & { readonly StdioClientTransport: typeof StdioClientTransport };

let sdk: McpSdk | undefined;

export async function loadMcpSdk(): Promise<McpSdk> {
  if (!sdk) {
    const [client, stdio] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ]);
    sdk = { ...client, StdioClientTransport: stdio.StdioClientTransport };
  }
  return sdk;
}

export const loadedMcpSdk = (): McpSdk | undefined => sdk;
