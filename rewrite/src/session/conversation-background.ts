/** Owns task/check-in publication, nested branches and notification admission. */
import { randomUUID } from 'node:crypto';
import type { TurnHandle, TurnId, TurnDeps } from '../engine/index.js';
import type { ModelError } from '../model/index.js';
import type { DirectOrigin } from './facade-types.js';
import type { Conversation, ConversationDeps } from './direct-types.js';
import type { CommandAdmission } from './conversation-command-admission.js';
import { ConversationJournal } from './conversation-journal.js';
import { ConversationGeneration } from './conversation-generation.js';
import { DirectRunBudgets } from './direct-run-budget.js';
import { DirectBackgroundTasks } from './direct-background.js';
import { directShellTasks } from './direct-shell-tasks.js';
import { DirectBackgroundCheckIns } from './direct-background-check-ins.js';
import { DirectTaskActivity } from './direct-task-activity.js';
import { DirectSubagents } from './direct-subagent.js';
import { createDirectBranchDriver } from './direct-branches.js';
import { factFor } from './conversation-turn.js';
import {
  directCheckInNotice,
  directTaskNotice,
  directNoticeText,
  directQuestionNotice,
  directShellOutputNotice,
  pendingDirectNotifications,
} from './direct-notifications.js';

export class ConversationBackground {
  readonly tasks: DirectBackgroundTasks;
  private readonly branchHandles = new Set<TurnHandle>();
  private readonly checkIns: DirectBackgroundCheckIns;
  private readonly activity = new DirectTaskActivity();
  private checkInTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly deps: ConversationDeps,
    private readonly journal: ConversationJournal,
    private readonly generation: ConversationGeneration,
    private readonly runBudgets: DirectRunBudgets,
    private readonly admission: Pick<CommandAdmission, 'closed' | 'newTurnId' | 'start'> & {
      busy(): boolean;
      destination(): string | undefined;
    },
  ) {
    this.tasks = new DirectBackgroundTasks({
      sessionId: this.journal.facts.find((fact) => fact.type === 'session_started')!.id,
      sink: {
        accept: (fact) => {
          const taskId =
            fact.type === 'task_started'
              ? fact.task.taskId
              : fact.type === 'task_interaction_opened'
              ? fact.request.taskId
              : fact.taskId;
          const previous = this.journal.taskStates.find((task) => task.taskId === taskId);
          const notice =
            previous &&
            !this.admission.closed &&
            (fact.type === 'task_question_opened'
              ? directQuestionNotice(previous, fact.question)
              : fact.type === 'task_backgrounded'
              ? directTaskNotice(previous, 'background')
              : // Legacy tells the model only about a user's stop of a background task; a cancelled turn's own work
              // is not one, and a model's stop answers in its own tool result.
              fact.type === 'task_stop_requested' && previous.mode === 'background' && fact.by !== 'model'
              ? directTaskNotice(previous, 'stop')
              : fact.type === 'task_finished' && previous.mode === 'background'
              ? directTaskNotice(previous, 'finished', fact.result)
              : undefined);
          if (
            (this.admission.closed &&
              (fact.type === 'task_started' ||
                fact.type === 'task_interaction_opened' ||
                fact.type === 'task_question_opened')) ||
            !this.journal.recover() ||
            !this.journal.commit([fact, ...(notice ? [{ type: 'background_notice_enqueued' as const, notice }] : [])])
          )
            throw new Error(this.journal.failure?.message ?? 'Session is closed');
          this.activity.accepted(fact);
          // The accepted projection already includes this wait/transfer; live task state may lag the sink.
          this.runBudgets.taskWaits(this.journal.taskStates);
        },
        publish: (event) => {
          if (event.type === 'task_progress' && event.kind === 'tool_progress')
            this.activity.shellOutput(event.taskId, event.chunk);
          this.deps.publishTask?.(event);
        },
        failed: this.journal.poison,
      },
    });
    this.checkIns = new DirectBackgroundCheckIns({
      tasks: this.tasks,
      settings: () => this.generation.supplied?.backgroundCheckIns?.() ?? { enabled: false, intervalMs: 1 },
      emit: (event) => {
        if (this.admission.closed || this.journal.failure) return;
        if (
          !this.journal.commit([
            {
              type: 'background_notice_enqueued',
              notice: directCheckInNotice(event, this.activity.details(event.details)),
            },
          ])
        )
          throw new Error(this.journal.failure!.message);
      },
    });
  }
  readonly configureTaskCheckIn: Conversation['configureTaskCheckIn'] = (target, policy) =>
    this.admission.closed || this.journal.failure
      ? { ok: false, code: 'not_active' }
      : this.checkIns.configure(target, policy);
  shellTaskPort(parent: Parameters<NonNullable<TurnDeps['shellTasks']>>[0], origin?: DirectOrigin) {
    return directShellTasks(this.tasks, parent, origin, (task, key, text) => {
      if (this.admission.closed || this.journal.failure) return;
      if (
        !this.journal.commit([{ type: 'background_notice_enqueued', notice: directShellOutputNotice(task, key, text) }])
      )
        throw new Error(this.journal.failure!.message);
    });
  }
  startCheckIns(): void {
    this.checkInTimer = this.generation.supplied?.backgroundCheckIns
      ? setInterval(() => {
          try {
            this.checkIns.tick();
          } catch (error) {
            this.journal.poison(error);
          }
        }, 30_000)
      : undefined;
    this.checkInTimer?.unref();
  }
  nested(
    turnDeps: ConversationDeps,
    rootTurnId: TurnId,
    origin: DirectOrigin | undefined,
  ): NonNullable<TurnDeps['runNested']> {
    const runNested: NonNullable<TurnDeps['runNested']> = async (nested, parent) => {
      if (!turnDeps.authorizeNested) throw new Error('App has not supplied direct nested authority');
      // Preserve the exact host-produced request for the surface's WeakMap authority lookup.
      const authority = await turnDeps.authorizeNested(nested, parent);
      parent.signal.throwIfAborted();
      const driver = createDirectBranchDriver({
        createDeps: (branchTurnId) => ({
          ...turnDeps,
          onTurnBoundary: ({ turnId }) => this.tasks.releaseParent(turnId),
          budget: this.runBudgets.open(branchTurnId, parent.turnId, turnDeps.budget),
          runNested,
          subagents: this.subagentPort,
          shellTasks: (parent) => this.shellTaskPort(parent, origin),
        }),
        parentTurnId: parent.turnId,
        rootTurnId,
        authority,
        accept: (fact) => {
          if (!this.journal.commit([fact])) throw new Error(this.journal.failure!.message);
          this.activity.accepted(fact);
        },
        factFor,
        handles: this.branchHandles,
        publish: turnDeps.publishBranch,
      });
      const agents = new DirectSubagents({ tasks: this.tasks, driver });
      const handle = agents.start({
        role: authority.role,
        task: authority.label,
        run: authority.request,
        workspace: authority.workspace,
        mode: nested.mode ?? 'foreground',
        ...(nested.name ? { name: nested.name } : {}),
        parentSignal: parent.signal,
        parentTurnId: parent.turnId,
        parentExecutionId: parent.parentExecutionId,
        ...(origin ? { origin } : {}),
      });
      if (nested.mode === 'background')
        return { runId: handle.runId, items: [], outcome: { kind: 'background', runId: handle.runId } };
      const result = await agents.waitForForeground(handle);
      if (result.kind === 'background')
        return { runId: handle.runId, items: [], outcome: { kind: 'background', runId: result.taskId } };
      if (result.result.value) return { ...result.result.value, runId: handle.runId };
      if (result.result.kind === 'failed')
        return { runId: handle.runId, items: [], outcome: { kind: 'failed', error: result.result.error } };
      return {
        runId: handle.runId,
        items: [],
        outcome: { kind: result.result.kind === 'cancelled' ? 'cancelled' : 'interrupted' },
      };
    };
    return runNested;
  }
  readonly subagentPort: NonNullable<TurnDeps['subagents']> = (parent) => {
    const check = (): void => {
      parent.signal.throwIfAborted();
      if (this.admission.closed || this.journal.failure)
        throw new Error(this.journal.failure?.message ?? 'Session is closed');
    };
    const get = (target: string): import('../tools/index.js').SubagentTaskState | undefined => {
      check();
      const task = this.tasks.get(target) ?? this.journal.taskStates.find((task) => task.taskId === target);
      return task?.kind === 'subagent' ? { ...task, kind: 'subagent' } : undefined;
    };
    return {
      list: () => {
        check();
        const live = new Map(this.tasks.list().map((task) => [task.taskId, task]));
        return this.journal.taskStates.flatMap((accepted) => {
          const task = live.get(accepted.taskId) ?? accepted;
          return task.kind === 'subagent' ? [{ ...task, kind: 'subagent' as const }] : [];
        });
      },
      get,
      wait: async (target, signal) => {
        const current = get(target);
        if (!current || current.result) return current;
        await this.tasks.wait(current.taskId, AbortSignal.any([parent.signal, signal]));
        return get(current.taskId);
      },
      message: (target, message, replyTo) => {
        check();
        return this.tasks.message(target, message, replyTo);
      },
      cancel: (target) => {
        const task = get(target);
        if (!task) return { ok: false, code: 'not_found' };
        if (task.result) return { ok: false, code: 'not_active' };
        return this.tasks.requestStop(task.taskId, 'model');
      },
    };
  };
  readonly drain: Conversation['drainBackgroundNotifications'] = (clientRequestId, settings) => {
    if (!clientRequestId.trim()) throw new Error('Background drain requires a nonempty invocation ID');
    if (this.admission.closed || this.journal.failure || !this.journal.recover())
      return { result: { kind: 'not_admitting', reason: this.journal.failure?.message ?? 'Session is closed' } };
    const previous = this.journal.notifications.deliveries.find(
      (delivery) => delivery.clientRequestId === clientRequestId,
    );
    if (previous)
      return {
        result: { kind: 'duplicate', turnId: previous.turnId, notificationIds: [...previous.notificationIds] },
      };
    if (this.admission.destination())
      return { result: { kind: 'not_admitting', reason: `Session rolled over to ${this.admission.destination()}` } };
    if (this.admission.busy()) return { result: { kind: 'busy' } };
    // Only accepted closure disproves a question notice. In particular, a
    // recovered interrupted task has no live continuation to answer. Preserve
    // other notices and unknown questions, and keep historical deliveries valid.
    const closedQuestions = new Set(
      this.journal.facts.flatMap((fact) =>
        fact.type === 'task_question_closed' ? [`question:${fact.taskId}:${fact.messageId}`] : [],
      ),
    );
    const notices = pendingDirectNotifications(this.journal.notifications).filter(
      (notice) => notice.kind !== 'question' || !closedQuestions.has(notice.id),
    );
    if (!notices.length) return { result: { kind: 'empty' } };
    const turnId = this.admission.newTurnId();
    const notificationIds = notices.map((notice) => notice.id);
    const started = this.admission.start(
      {
        ...settings,
        input: [
          {
            type: 'user_message',
            id: `background:${randomUUID()}` as import('../model/index.js').ItemId,
            content: [{ type: 'text', text: directNoticeText(notices) }],
          },
        ],
      },
      {
        turnId,
        silent: true,
        facts: [{ type: 'background_notices_delivered', clientRequestId, turnId, notificationIds }],
      },
    );
    return { result: { kind: 'started', turnId, notificationIds }, started };
  };
  poison(error: ModelError): void {
    this.tasks.poison(error);
    for (const handle of this.branchHandles) handle.cancel();
  }
  stopCheckIns(): void {
    if (this.checkInTimer) clearInterval(this.checkInTimer);
  }
}
