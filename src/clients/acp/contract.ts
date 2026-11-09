import type * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk';
import type { WireModel, WireConfigureRequest } from '../../protocol/wire.js';
import type { WireAnswerProvenance, WireDecision } from '../../protocol/wire.js';
import type { DirectHost, DirectConnection, Principal, WorkspaceGrant } from '../../host/in-process-direct-types.js';
import type { McpServer } from '@agentclientprotocol/sdk';

export type AcpSessionSetup = {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly mcpServers?: readonly McpServer[];
};

/** Version-specific transports implement only the client operations used by the backend. */
export interface AcpClient {
  readonly supportsShellEscape?: boolean;
  /** Mark the exact locally submitted message before opening its output gate. */
  promptAccepted?(sessionId: string, messageId: string): void;
  update(notification: acp.UpdateSessionNotification): Promise<void>;
  permission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  supportsForms(): Promise<boolean>;
  elicit(request: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
}

/** Preserve whether an answer came from a client action or a local failure fallback. */
export type AcpAnswer = { readonly decision: WireDecision; readonly provenance: WireAnswerProvenance };

export type EmitUpdate = (update: acp.SessionUpdate) => Promise<void>;
export type PromptOutcome = { readonly stopReason: acp.StopReason };
export type PromptExecution = {
  /** Opens the output gate after the ACP prompt acknowledgement has been sent. */
  run(emit: EmitUpdate, signal: AbortSignal): Promise<PromptOutcome>;
};

/** Host-owned workspace authorization and metadata absent from DirectHost's connect DTO. */
export interface AcpWorkspaces {
  authorize(cwd: string): Promise<WorkspaceGrant>;
  /** Canonical cwd of a direct session, checked under the same principal as Host. */
  cwd(sessionId: string): Promise<string>;
}

export type AcpLogger = {
  error(message: string, fields: Readonly<Record<string, unknown>>): void;
};

export type AcpApprovalMode = 'ask' | 'assisted' | 'always';

export type BackendOptions = {
  readonly host: DirectHost;
  readonly principal: Principal;
  readonly workspaces: AcpWorkspaces;
  readonly logger: AcpLogger;
  readonly createRequestId?: () => string;
  /** App owns supplied MCP processes, tool generations and lifetime; the backend only attaches. */
  readonly sessions?: {
    open(request: AcpSessionSetup, connect: () => Promise<DirectConnection>): Promise<DirectConnection>;
    close(sessionId: string): Promise<void>;
  };
  /** Cache-only for setup; refresh may contact credentialed provider catalogs. */
  readonly models?: (refresh: boolean) => Promise<readonly (WireModel & { readonly name?: string })[]>;
  /** App-owned v1 policy and accepted configuration. */
  readonly approval?: {
    get(sessionId: string): Promise<AcpApprovalMode>;
    set(sessionId: string, mode: AcpApprovalMode): Promise<void>;
    review(sessionId: string, requestId: string, signal: AbortSignal): Promise<boolean>;
  };
  /** Accepted session intent, preserving Default even when its effective effort is concrete. */
  readonly configuration?: (sessionId: string) => Promise<{
    readonly model: WireModel;
    readonly reasoning: NonNullable<WireConfigureRequest['reasoning']>;
  }>;
};

/** ACP lifecycle over owned connection subscriptions, never over a Session runtime. */
export interface AcpBackend {
  readonly mcpCapabilities?: { readonly http: boolean; readonly sse: boolean };
  configOptions?(sessionId: string, refresh?: boolean): Promise<SessionConfigOption[]>;
  setConfigOption?(request: SetSessionConfigOptionRequest): Promise<SessionConfigOption[]>;
  createSession(request: AcpSessionSetup, client: AcpClient): Promise<acp.NewSessionResponse>;
  listSessions(request: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse>;
  resumeSession(
    request: Pick<acp.ResumeSessionRequest, 'sessionId' | 'cwd' | 'replayFrom'> & Pick<AcpSessionSetup, 'mcpServers'>,
    client: AcpClient,
  ): Promise<acp.ResumeSessionResponse>;
  preparePrompt(request: acp.PromptRequest): Promise<PromptExecution>;
  cancelSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** Detach subscriptions; the app, not this client, owns Host shutdown. */
  shutdown(): Promise<void>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
