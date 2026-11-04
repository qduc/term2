/**
 * Legacy's background notification shapes and their model-facing text, copied from
 * source/services/conversation/conversation-orchestrator.ts (formatBackgroundSubagentNotifications). Keep the
 * wording byte-identical to legacy; the Session maps its own task facts onto these shapes.
 */

export type DirectLegacyNotification =
  | {
      readonly kind: 'completion';
      readonly runId: string;
      readonly role: string;
      readonly status: string;
      readonly error?: string;
      readonly formattedResult: string;
    }
  | {
      readonly kind: 'question';
      readonly messageId: string;
      readonly runId: string;
      readonly name?: string;
      readonly role: string;
      readonly question: string;
    }
  | {
      readonly kind: 'shell_completion';
      readonly jobId: string;
      readonly command: string;
      readonly status: string;
      readonly output: string;
      readonly error?: string;
    }
  | {
      readonly kind: 'shell_output';
      readonly jobId: string;
      readonly command: string;
      readonly watchId: string;
      readonly seq: number;
      readonly matchedLines: string;
      readonly droppedBytes?: number;
    }
  | {
      readonly kind: 'check_in';
      readonly checkInIndex: number;
      readonly elapsedMs: number;
      readonly details:
        | {
            readonly kind: 'subagent';
            readonly id: string;
            readonly name?: string;
            readonly role: string;
            readonly task: string;
          }
        | { readonly kind: 'shell'; readonly id: string; readonly command: string; readonly status?: string };
    }
  | {
      readonly kind: 'user_control';
      readonly action: 'stop' | 'background';
      readonly details:
        | {
            readonly kind: 'subagent';
            readonly id: string;
            readonly name?: string;
            readonly role: string;
            readonly task: string;
          }
        | { readonly kind: 'shell'; readonly id: string; readonly command: string };
    };

type Of<K extends DirectLegacyNotification['kind']> = Extract<DirectLegacyNotification, { kind: K }>;
const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

/** Render pending notifications as one instruction, grouped by kind in legacy's order. */
export function formatDirectLegacyNotifications(notifications: readonly DirectLegacyNotification[]): string {
  const of = <K extends DirectLegacyNotification['kind']>(kind: K) =>
    notifications.filter((notification): notification is Of<K> => notification.kind === kind);
  const completions = of('completion');
  const questions = of('question');
  const shellCompletions = of('shell_completion');
  const shellOutputs = of('shell_output');
  const checkIns = of('check_in');
  const userControls = of('user_control');
  const sections: string[] = [];

  if (completions.length > 0) {
    const noun = completions.length === 1 ? 'run' : 'runs';
    const entries = completions.map((notification) =>
      [
        `- runId: ${notification.runId} | role: ${notification.role} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        '  result:',
        indent(notification.formattedResult),
      ].join('\n'),
    );
    sections.push(
      [
        `Background subagent ${noun} finished (${completions.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'The full result is inlined above; you do not need to call tools.get_subagent_result(...) inside run_code. Assess it against the task before you accept it, then continue through the next necessary steps yourself rather than stopping at the fact that a run finished. Tell the user concisely, in your own words, what you concluded — the report is input to your judgement, not a message to relay.',
      ].join('\n'),
    );
  }

  if (questions.length > 0) {
    const entries = questions.map((notification) => {
      const target = notification.name ?? notification.runId;
      return [
        `- messageId: ${notification.messageId} | target: ${target} | runId: ${notification.runId} | role: ${notification.role}`,
        `  question: ${notification.question}`,
      ].join('\n');
    });
    sections.push(
      [
        `Background subagent question${questions.length === 1 ? '' : 's'} pending (${
          questions.length
        }). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Decide the answer, investigate it yourself, or escalate to the user if needed. To answer a specific waiting subagent, use run_code with tools.send_message({ target, reply_to: messageId, message }). The subagent has no direct user channel; an answer resumes only its waiting tool call.',
      ].join('\n'),
    );
  }

  if (shellCompletions.length > 0) {
    const noun = shellCompletions.length === 1 ? 'job' : 'jobs';
    const entries = shellCompletions.map((notification) =>
      [
        `- jobId: ${notification.jobId} | command: ${notification.command} | status: ${notification.status}`,
        ...(notification.error ? [`  error: ${notification.error}`] : []),
        '  output:',
        indent(notification.output),
      ].join('\n'),
    );
    sections.push(
      [
        `Background shell ${noun} finished (${shellCompletions.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Assess the command result against the task and continue through the next necessary steps. Tell the user concisely, in your own words, what you concluded.',
      ].join('\n'),
    );
  }

  if (shellOutputs.length > 0) {
    const noun = shellOutputs.length === 1 ? 'watch' : 'watches';
    const entries = shellOutputs.map((notification) =>
      [
        `- jobId: ${notification.jobId} | command: ${notification.command} | watchId: ${notification.watchId} | seq: ${notification.seq}`,
        ...(notification.droppedBytes !== undefined ? [`  droppedBytes: ${notification.droppedBytes}`] : []),
        '  matchedLines:',
        indent(notification.matchedLines),
      ].join('\n'),
    );
    sections.push(
      [
        `Background shell ${noun} matched output (${shellOutputs.length}). This is an automatic system notification, not a user message.`,
        '',
        ...entries,
        '',
        'Assess whether the matched output changes what you should do next and continue through the next necessary steps yourself, telling the user concisely, in your own words, what you concluded.',
      ].join('\n'),
    );
  }

  if (checkIns.length > 0) {
    const noun = checkIns.length === 1 ? 'task' : 'tasks';
    // Legacy also reports liveness, narrative and tool counts; the Session keeps no such activity record.
    const entries = checkIns.map((notification) => {
      const { details } = notification;
      const elapsedSeconds = Math.round(notification.elapsedMs / 1000);
      if (details.kind === 'subagent') {
        const nameLabel = details.name ? `${details.name} (${details.id})` : details.id;
        return [
          `- background subagent ${nameLabel} | role: ${details.role} | task: ${details.task}`,
          `  still running, elapsed ${elapsedSeconds}s, check-in #${notification.checkInIndex}`,
        ].join('\n');
      }
      const statusDesc = details.status ? `status: ${details.status} | ` : '';
      return [
        `- background shell | jobId: ${details.id} | command: ${details.command}`,
        `  ${statusDesc}still running, elapsed ${elapsedSeconds}s, check-in #${notification.checkInIndex}`,
      ].join('\n');
    });
    sections.push(
      [
        `Periodic check-in on ${checkIns.length} still-running background ${noun}. This is an automatic system notification, not a user message, and does not by itself mean anything is wrong.`,
        '',
        ...entries,
        '',
        'Decide freely: doing nothing and letting it keep running is a valid choice. Scope that silence instruction to this check-in acknowledgement: only if this check-in is the sole reason for the turn and nothing remains actionable should you end this check-in turn silently: produce no assistant prose, acknowledgement, or filler. If ongoing authorized work is already in progress when this notification arrives, continue that work; do not end the turn merely because this check-in needs no action or update. To adjust check-in frequency or silence future check-ins for a task, use run_code with tools.configure_task_check_in(...). Only report to the user or intervene (steer or stop the task) if the elapsed time or task nature makes that the right call.',
      ].join('\n'),
    );
  }

  if (userControls.length > 0) {
    const stopControls = userControls.filter((notification) => notification.action === 'stop');
    const backgroundMoves = userControls.filter((notification) => notification.action === 'background');
    const entriesFor = (controls: typeof userControls, verb: string) =>
      controls.map((notification) => {
        const details = notification.details;
        return details.kind === 'subagent'
          ? `- ${verb} background subagent ${details.name ?? details.id} | runId: ${details.id} | role: ${
              details.role
            } | task: ${details.task}`
          : `- ${verb} background shell | jobId: ${details.id} | command: ${details.command}`;
      });
    if (stopControls.length > 0) {
      sections.push(
        [
          `The user requested that ${
            stopControls.length === 1 ? 'a background task be stopped' : 'background tasks be stopped'
          }. This is an automatic user control notification, not a user message.`,
          '',
          ...entriesFor(stopControls, 'stop requested for'),
          '',
          'Plan the next step around the requested stop. The task may settle later with a cancelled completion notification; do not assume its result is available yet.',
        ].join('\n'),
      );
    }
    if (backgroundMoves.length > 0) {
      const movedSubagents = backgroundMoves.filter((notification) => notification.details.kind === 'subagent').length;
      const movedShells = backgroundMoves.length - movedSubagents;
      const movedWhat =
        movedSubagents > 0 && movedShells === 0
          ? movedSubagents === 1
            ? 'a foreground subagent into the background'
            : 'foreground subagents into the background'
          : movedShells > 0 && movedSubagents === 0
          ? movedShells === 1
            ? 'a foreground shell into the background'
            : 'foreground shells into the background'
          : 'foreground work into the background';
      sections.push(
        [
          `The user moved ${movedWhat}. This is an automatic user control notification, not a user message.`,
          '',
          ...entriesFor(backgroundMoves, 'moved to'),
          '',
          'The same execution continues running in the background. The user moved it here so you are not stuck waiting on this task. If other work remains, continue with it; otherwise ending the turn is fine. Do not stop or relaunch the moved task, and do not treat it as finished — it will notify you when it settles.',
        ].join('\n'),
      );
    }
  }

  return sections.join('\n\n');
}
