/** Composition inputs for the direct control adapter. None may access an old runtime. */
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireSnapshot, WireSubmission } from '../../protocol/wire.js';
import type { ControlSessionPort, ControlSocketServer } from './transport.js';

export interface ControlSessionMetadata {
  readonly workspaceRoot: string | null;
  readonly version: string;
  readonly createdAt: string;
  readonly logPath: string;
  readonly profileId?: string | null;
  readonly autoApproveMode?: string | null;
  readonly contextWindow?: number | null;
  readonly cacheCreationTokens?: number | null;
  /** Public wire totalUsd alone cannot establish pricing coverage or request counts. */
  readonly cost?: {
    readonly knownUsdMicros: number;
    readonly pricedRequests: number;
    readonly unpricedRequests: number;
    readonly state: 'exact' | 'estimated' | 'partial' | 'unavailable';
  } | null;
}

export type ControlSubmission = WireSubmission;

export interface DirectControlPortOptions {
  /** Dedicated snapshot+live attachment, not a tail-only replay connection. */
  readonly connection: DirectConnection;
  readonly controlSocket: Pick<ControlSocketServer, 'name' | 'startedAt'>;
  readonly metadata: (snapshot: WireSnapshot) => ControlSessionMetadata;
}

export interface DirectControlSessionPort extends ControlSessionPort {
  /** Resolves on detach, event-stream end or failure; never implies Session completion. */
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  readonly failure: unknown;
  /** Detach only. App owns Host disposal and Session cancellation. */
  close(): void;
}
