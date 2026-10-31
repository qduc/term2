import type * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { DirectHost, Principal, WorkspaceGrant } from '../../host/in-process-direct-types.js';

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

export type BackendOptions = {
  readonly host: DirectHost;
  readonly principal: Principal;
  readonly workspaces: AcpWorkspaces;
  readonly logger: AcpLogger;
  readonly createRequestId?: () => string;
};

/** ACP lifecycle over owned connection subscriptions, never over a Session runtime. */
export interface AcpBackend {
  createSession(request: Pick<acp.NewSessionRequest, 'cwd'>, client: acp.AgentContext): Promise<acp.NewSessionResponse>;
  listSessions(request: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse>;
  resumeSession(
    request: Pick<acp.ResumeSessionRequest, 'sessionId' | 'cwd' | 'replayFrom'>,
    client: acp.AgentContext,
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
