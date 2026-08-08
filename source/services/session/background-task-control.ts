import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { BackgroundShellJob } from '../shell/background-shell-registry.js';
import type { ForegroundShellLeaseDetails, ForegroundShellTransferResult } from '../shell/background-shell-registry.js';
import type { SubagentCancelAcknowledgement, SubagentRunHandle, SubagentRunStatus } from '../subagents/types.js';
import type { ForegroundSubagentCandidate } from '../subagents/nested-runner.js';
import type { BackgroundSubagentNotificationPort } from '../subagents/subagent-notification-store.js';

export type BackgroundTaskControlTarget = { kind: 'subagent'; id: string } | { kind: 'shell'; id: string };
export type ForegroundTaskControlTarget = { kind: 'shell'; callId: string } | { kind: 'subagent'; runId: string };

export type BackgroundTaskControlDetails =
  | {
      kind: 'subagent';
      id: string;
      name?: string;
      role: string;
      task: string;
      taskPreview: string;
      status: Exclude<SubagentRunStatus['status'], 'not_found'>;
      startedAt: number;
      elapsedMs: number;
      lastToolName?: string;
      lastToolAt?: number;
      toolCounts: Record<string, number>;
      turnHistory?: SubagentRunStatus['turnHistory'];
      currentText?: string;
      pendingToolCounts?: Record<string, number>;
    }
  | {
      kind: 'shell';
      id: string;
      command: string;
      status: BackgroundShellJob<unknown>['status'];
      startedAt: number;
      completedAt?: number;
      output?: string;
      error?: string;
    };

export type BackgroundTaskStopResult =
  | { ok: true; details: BackgroundTaskControlDetails }
  | { ok: false; code: 'not_found' | 'not_active' | 'unavailable' };

/** A live root-shell call which has not yet been made visible as background work. */
export type ForegroundShellTaskControlDetails = {
  kind: 'shell';
  callId: string;
  jobId: string;
  command: string;
  status: 'running';
  startedAt: number;
};

export type ForegroundSubagentTaskControlDetails = ForegroundSubagentCandidate & {
  kind: 'subagent';
  status: 'running';
};
/** Legacy singular foreground candidate: the root-shell transfer surface. */
export type ForegroundTaskControlDetails = ForegroundShellTaskControlDetails;
export type ForegroundTransferCandidate = ForegroundShellTaskControlDetails | ForegroundSubagentTaskControlDetails;

export type MoveForegroundToBackgroundResult =
  | { ok: true; details: BackgroundTaskControlDetails }
  | { ok: false; code: 'not_found' | 'not_active' | 'unavailable' | 'capacity' };

export interface BackgroundTaskControlPort {
  listDetails(): readonly BackgroundTaskControlDetails[];
  getDetails(target: BackgroundTaskControlTarget): BackgroundTaskControlDetails | null;
  requestStop(target: BackgroundTaskControlTarget): BackgroundTaskStopResult;
  getForegroundTransferCandidate(): ForegroundShellTaskControlDetails | null;
  listForegroundTransferCandidates(): readonly ForegroundTransferCandidate[];
  moveForegroundToBackground(target: ForegroundTaskControlTarget): MoveForegroundToBackgroundResult;
}

/** The small root-client capability this control surface needs. */
type BackgroundTaskControlClient = Pick<
  ConversationAgentClient,
  | 'getBackgroundSubagentStatus'
  | 'listBackgroundSubagentStatuses'
  | 'requestBackgroundSubagentStop'
  | 'getBackgroundShellJob'
  | 'listBackgroundShellJobs'
  | 'requestBackgroundShellStop'
  | 'getForegroundShellTransferCandidate'
  | 'moveForegroundShellToBackground'
  | 'listForegroundSubagentCandidates'
  | 'moveForegroundSubagent'
> & {
  getBackgroundSubagentStatus?: (runId: string) => SubagentRunStatus;
  listBackgroundSubagentStatuses?: () => SubagentRunStatus[];
  requestBackgroundSubagentStop?: (runId: string) => SubagentCancelAcknowledgement;
  getBackgroundShellJob?: (jobId: string) => BackgroundShellJob<unknown> | undefined;
  listBackgroundShellJobs?: () => BackgroundShellJob<unknown>[];
  requestBackgroundShellStop?: (jobId: string) => boolean;
  getForegroundShellTransferCandidate?: () => ForegroundShellLeaseDetails | undefined;
  moveForegroundShellToBackground?: (callId: string) => ForegroundShellTransferResult | undefined;
  listForegroundSubagentCandidates?: () => ForegroundSubagentCandidate[];
  moveForegroundSubagent?: (runId: string) => SubagentRunHandle | undefined;
};

/**
 * UI-facing control surface for conversation-owned background work.
 *
 * Registries remain the authority for liveness and cancellation. This module
 * hides their different identifier and outcome conventions, and owns the
 * companion main-agent notification so callers cannot stop work without
 * informing the next planning step.
 */
export class BackgroundTaskControl implements BackgroundTaskControlPort {
  readonly #client: BackgroundTaskControlClient;
  readonly #notifications: BackgroundSubagentNotificationPort;
  readonly #onNotification?: () => void;
  readonly #onTaskChange?: () => void;

  constructor({
    client,
    notifications,
    onNotification,
    onTaskChange,
  }: {
    client: BackgroundTaskControlClient;
    notifications: BackgroundSubagentNotificationPort;
    onNotification?: () => void;
    onTaskChange?: () => void;
  }) {
    this.#client = client;
    this.#notifications = notifications;
    this.#onNotification = onNotification;
    this.#onTaskChange = onTaskChange;
  }

  /** Lists live registry entries first, followed by retained terminal entries. */
  listDetails(): readonly BackgroundTaskControlDetails[] {
    const subagents = this.#client.listBackgroundSubagentStatuses?.() ?? [];
    const shells = this.#client.listBackgroundShellJobs?.() ?? [];
    const details = [
      ...subagents.map((status) => this.#subagentDetails(status)).filter(isDefined),
      ...shells.map((job) => this.#shellDetails(job)),
    ];
    return details.sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)));
  }

  getDetails(target: BackgroundTaskControlTarget): BackgroundTaskControlDetails | null {
    if (target.kind === 'subagent') {
      const status = this.#client.getBackgroundSubagentStatus?.(target.id);
      return status ? this.#subagentDetails(status) : null;
    }
    const job = this.#client.getBackgroundShellJob?.(target.id);
    return job ? this.#shellDetails(job) : null;
  }

  requestStop(target: BackgroundTaskControlTarget): BackgroundTaskStopResult {
    const before = this.getDetails(target);
    if (!before) return { ok: false, code: this.#isAvailable(target) ? 'not_found' : 'unavailable' };

    if (target.kind === 'subagent') {
      const acknowledged = this.#client.requestBackgroundSubagentStop?.(target.id);
      if (!acknowledged) return { ok: false, code: 'unavailable' };
      if (!acknowledged.ok) return { ok: false, code: 'not_active' };
      const details = { ...before, status: 'cancelling' as const };
      this.#notifyStop(target, details);
      return { ok: true, details };
    }

    const stopped = this.#client.requestBackgroundShellStop?.(target.id);
    if (stopped === undefined) return { ok: false, code: 'unavailable' };
    if (!stopped) return { ok: false, code: 'not_active' };
    const details = { ...before, status: 'cancelling' as const };
    this.#notifyStop(target, details);
    return { ok: true, details };
  }

  getForegroundTransferCandidate(): ForegroundShellTaskControlDetails | null {
    const candidate = this.#client.getForegroundShellTransferCandidate?.();
    return candidate ? this.#foregroundShellDetails(candidate) : null;
  }

  listForegroundTransferCandidates(): readonly ForegroundTransferCandidate[] {
    const shell = this.getForegroundTransferCandidate();
    const subagents = this.#client.listForegroundSubagentCandidates?.() ?? [];
    return [
      ...(shell ? [shell] : []),
      ...subagents.map((candidate) => ({ ...candidate, kind: 'subagent' as const, status: 'running' as const })),
    ];
  }

  moveForegroundToBackground(target: ForegroundTaskControlTarget): MoveForegroundToBackgroundResult {
    if (target.kind === 'subagent') return this.#moveForegroundSubagent(target.runId);
    const before = this.getForegroundTransferCandidate();
    if (!before || before.callId !== target.callId) {
      return { ok: false, code: this.#client.getForegroundShellTransferCandidate ? 'not_found' : 'unavailable' };
    }
    const move = this.#client.moveForegroundShellToBackground;
    if (!move) return { ok: false, code: 'unavailable' };
    let adopted: ForegroundShellTransferResult | undefined;
    try {
      adopted = move(target.callId);
    } catch (error) {
      if (error instanceof Error && error.name === 'BackgroundShellRegistryCapacityError') {
        return { ok: false, code: 'capacity' };
      }
      return { ok: false, code: 'not_active' };
    }
    if (!adopted) return { ok: false, code: 'not_active' };
    const job = this.#client.getBackgroundShellJob?.(adopted.jobId);
    if (!job) return { ok: false, code: 'not_active' };
    const details = this.#shellDetails(job);
    const queued = this.#notifications.enqueueUserControl({
      action: 'background',
      target: { kind: 'shell', id: adopted.jobId },
      details: { kind: 'shell', id: adopted.jobId, command: details.command },
    });
    if (queued) this.#onNotification?.();
    this.#onTaskChange?.();
    return { ok: true, details };
  }

  #moveForegroundSubagent(runId: string): MoveForegroundToBackgroundResult {
    const candidate = (this.#client.listForegroundSubagentCandidates?.() ?? []).find((item) => item.runId === runId);
    if (!candidate) {
      return { ok: false, code: this.#client.listForegroundSubagentCandidates ? 'not_found' : 'unavailable' };
    }
    const move = this.#client.moveForegroundSubagent;
    if (!move) return { ok: false, code: 'unavailable' };
    let adopted: SubagentRunHandle | undefined;
    try {
      adopted = move(runId);
    } catch (error) {
      if (error instanceof Error && error.name === 'SubagentRegistryError') return { ok: false, code: 'capacity' };
      return { ok: false, code: 'not_active' };
    }
    if (!adopted) return { ok: false, code: 'not_active' };
    const details = this.getDetails({ kind: 'subagent', id: adopted.runId });
    if (!details) return { ok: false, code: 'not_active' };
    const queued = this.#notifications.enqueueUserControl({
      action: 'background',
      target: { kind: 'subagent', id: adopted.runId },
      details: { kind: 'subagent', id: adopted.runId, role: adopted.role, task: adopted.task },
    });
    if (queued) this.#onNotification?.();
    this.#onTaskChange?.();
    return { ok: true, details };
  }

  #isAvailable(target: BackgroundTaskControlTarget): boolean {
    return target.kind === 'subagent'
      ? typeof this.#client.getBackgroundSubagentStatus === 'function'
      : typeof this.#client.getBackgroundShellJob === 'function';
  }

  #notifyStop(target: BackgroundTaskControlTarget, details: BackgroundTaskControlDetails): void {
    const queued = this.#notifications.enqueueUserControl({ action: 'stop', target, details });
    if (queued) this.#onNotification?.();
    // The lifecycle projection intentionally stays compact and does not grow a
    // transient `cancelling` state. Wake its observer so a control-aware UI can
    // re-read this port immediately, then wait for the normal terminal event.
    this.#onTaskChange?.();
  }

  #subagentDetails(status: SubagentRunStatus): Extract<BackgroundTaskControlDetails, { kind: 'subagent' }> | null {
    if (status.status === 'not_found') return null;
    const { runId, ...details } = status;
    return {
      kind: 'subagent',
      id: runId,
      ...details,
      status: status.status as Exclude<SubagentRunStatus['status'], 'not_found'>,
    };
  }

  #shellDetails(job: BackgroundShellJob<unknown>): Extract<BackgroundTaskControlDetails, { kind: 'shell' }> {
    const { id, result, ...details } = job;
    const output =
      result && typeof result === 'object' && 'output' in result && typeof result.output === 'string'
        ? result.output
        : undefined;
    return { kind: 'shell', id, ...details, ...(output === undefined ? {} : { output }) };
  }

  #foregroundShellDetails(candidate: ForegroundShellLeaseDetails): ForegroundShellTaskControlDetails {
    return { kind: 'shell', ...candidate };
  }
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function isTerminal(details: BackgroundTaskControlDetails): boolean {
  return details.status !== 'running' && details.status !== 'waiting_for_answer' && details.status !== 'cancelling';
}
