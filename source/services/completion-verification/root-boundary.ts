import type { NestedRunDriverFactory } from '../../contracts/nested-run-driver.js';
import envPaths from 'env-paths';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ApplicationRunLoopDeps } from '../agent-runtime/application-run-loop.js';
import { createOpenRouterDecisionClient } from '../decision-shadow/decision-client.js';
import { DEFAULT_BUDGETS, type CompletionVerdict } from './contracts.js';
import { createVerificationGate } from './gate.js';
import { CompletionVerificationOrchestrator } from './orchestrator.js';
import { VerificationStore } from './store.js';
import { UnsupportedWorkspaceError, snapshotWorkspace, type WorkspaceSnapshot } from './workspace.js';
import { createIndependentVerifier, runQuickCheck } from './verifier.js';

/** Root durable-goal adapter. The generic orchestrator has no dependency on conversational state. */
export class RootCompletionBoundary {
  #store?: VerificationStore;
  #orchestrator?: CompletionVerificationOrchestrator;
  constructor(
    private deps: {
      driverFactory: NestedRunDriverFactory;
      settings: ISettingsService;
      logger: ILoggingService;
      executionContext?: ExecutionContext;
      resolveModel: ApplicationRunLoopDeps['resolveModel'];
      model(): string;
    },
  ) {}

  #openStore(): VerificationStore {
    return (this.#store ??= new VerificationStore(path.join(envPaths('term2').data, 'completion-verification.sqlite')));
  }

  /**
   * An unsupported workspace is an explicit outcome, not a generic failure: the user
   * gets the reason and the operator gets an alert naming the task and the cause.
   */
  #unsupported(reason: string, message: string, goal: DurableGoal, cwd: string, detail?: string): CompletionVerdict {
    this.deps.logger.error('Completion verification cannot inspect this workspace', {
      eventType: 'completion_verification.operational_alert',
      reason,
      detail: detail ?? message,
      environment: cwd,
      taskId: createHash('sha256').update(`${cwd}\0${goal.id}`).digest('hex'),
    });
    return { action: 'blocked', reason: `Unsupported workspace: ${message}` };
  }

  async verify(
    goal: DurableGoal,
    history: readonly ProviderInputItem[],
    signal?: AbortSignal,
  ): Promise<CompletionVerdict> {
    const cwd = this.deps.executionContext?.getCwd() ?? process.cwd();
    if (this.deps.executionContext?.isRemote())
      return this.#unsupported(
        'remote-workspace-unsupported',
        'Remote workspace verification is unavailable',
        goal,
        cwd,
      );
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await snapshotWorkspace(cwd);
    } catch (error) {
      if (error instanceof UnsupportedWorkspaceError)
        return this.#unsupported(error.reason, error.message, goal, cwd, error.detail);
      throw error;
    }
    if (signal?.aborted) return { action: 'blocked', reason: 'Completion verification cancelled' };
    if (!this.#orchestrator) {
      const settings = this.deps.settings;
      this.#orchestrator = new CompletionVerificationOrchestrator(
        this.#openStore(),
        {
          gate: createVerificationGate({
            client: createOpenRouterDecisionClient({
              resolveTransport: () => ({
                apiKey: settings.get('agent.openrouter.apiKey') || process.env.OPENROUTER_API_KEY || '',
                baseUrl: settings.get('agent.openrouter.baseUrl'),
              }),
            }),
            model: () => settings.get('agent.decisionModel'),
          }),
          verify: createIndependentVerifier({
            driverFactory: this.deps.driverFactory,
            resolveModel: this.deps.resolveModel,
            model: () => settings.get('verifier.model') || this.deps.model(),
          }),
          quickCheck: runQuickCheck,
          currentRevision: async () =>
            (await snapshotWorkspace(this.deps.executionContext?.getCwd() ?? process.cwd())).revision,
          observe: (record) =>
            this.deps.logger.info('Completion verification transition', {
              eventType: 'completion_verification.transition',
              taskId: record.taskId,
              revision: record.revision,
              state: record.state,
              attemptId: record.attemptId,
              generation: record.generation,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              gateLatencyMs: record.gateLatencyMs,
              verificationLatencyMs: record.verificationLatencyMs,
              gate: record.decision,
              outcome: record.report?.outcome,
              reportAttemptId: record.report?.attemptId,
              reportRevision: record.report?.revision,
              reportCurrent: record.report?.attemptId === record.attemptId,
              verifierVersion: record.report?.verifierVersion,
              costUsdMicros: record.report?.costUsdMicros,
              repairs: record.repairs,
              gates: record.gates,
              verifications: record.verifications,
              deadline: record.deadline,
              reason: record.reason,
            }),
          alert: (message) =>
            this.deps.logger.error(message, { eventType: 'completion_verification.operational_alert' }),
        },
        { ...DEFAULT_BUDGETS, maxRepairs: settings.get('agent.verificationMaxRepairs') ?? 3 },
      );
    }
    const call = [...history].reverse().find((item) => item.name === 'goal_check' && item.arguments !== undefined);
    let evidence = 'Recorded worker completion claim';
    if (call) {
      try {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
        if (typeof args?.evidence === 'string') evidence = args.evidence;
      } catch {
        /* Validated at the goal-stop seam; missing evidence falls back conservatively. */
      }
    }
    const criteria = goal.successCriteria ?? '';
    this.#orchestrator.configureNewTaskBudgets({
      ...DEFAULT_BUDGETS,
      maxRepairs: this.deps.settings.get('agent.verificationMaxRepairs') ?? 3,
    });
    return this.#orchestrator.propose(
      {
        ...snapshot,
        taskId: createHash('sha256').update(`${snapshot.environment}\0${goal.id}`).digest('hex'),
        goal: goal.outcome,
        criteria,
        evidence,
        ...(criteria.trim() === 'git diff --check' &&
        snapshot.classification === 'documentation' &&
        snapshot.files.length > 0
          ? { quickCheck: 'diff_whitespace' }
          : {}),
      },
      signal,
    );
  }

  dispose(): void {
    this.#store?.close();
  }
}
