/**
 * What a background task has visibly done lately, for legacy's check-in lines: liveness, the subagent's latest
 * narrative, tool counts and last tool, and a shell's recent output. Live-only, like legacy's registries: it is
 * fed by the branch facts and shell output the Session already sees, and a restarted Session starts it empty.
 */
import type { Fact } from './facts.js';
import type { DirectTaskState } from './background-types.js';
import type { DirectTaskActivityDetails } from './notice-format.js';

type Observation = { readonly kind: string; readonly at: number };
type Track = {
  readonly kind: 'shell' | 'subagent';
  observation: Observation;
  state: 'active' | 'waiting' | 'cancelling';
  reason?: 'provider' | 'approval' | 'answer';
  inStream: boolean;
  currentText: string;
  lastTurnText?: string;
  readonly toolCounts: Map<string, number>;
  lastToolName?: string;
  outputTail: string;
};

const SUBAGENT_QUIET_AFTER_MS = 30_000;
const SHELL_QUIET_AFTER_MS = 10_000;
const TOOL_LABEL_LIMIT = 80;
const SHELL_TAIL_CHARS = 400;
/** Legacy keeps this much of the streamed text, and of each finished turn's text. */
const PEEK_TEXT_CHARS = 200;

export class DirectTaskActivity {
  readonly #tracks = new Map<string, Track>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #track(taskId: string, kind: Track['kind'], at: number): Track {
    let track = this.#tracks.get(taskId);
    if (!track) {
      // Legacy dispatches a subagent's first request (and starts a shell) as the run starts.
      track = {
        kind,
        observation: { kind: 'request_dispatched', at },
        state: 'waiting',
        reason: 'provider',
        inStream: false,
        currentText: '',
        toolCounts: new Map(),
        outputTail: '',
      };
      this.#tracks.set(taskId, track);
    }
    return track;
  }

  #observe(track: Track, kind: string, state: Track['state'], reason?: Track['reason']): void {
    if (track.observation.kind === 'stop_requested') return;
    track.observation = { kind, at: this.#now() };
    track.state = state;
    track.reason = state === 'waiting' ? reason : undefined;
  }

  /** A fact the Session accepted: task lifecycle facts and a subagent branch's own facts. */
  accepted(fact: Fact): void {
    if (fact.type === 'task_started') {
      this.#track(fact.task.taskId, fact.task.kind, fact.task.startedAt);
      return;
    }
    if (fact.type === 'task_finished') {
      this.#tracks.delete(fact.taskId);
      return;
    }
    if (fact.type === 'task_interaction_opened') {
      const track = this.#tracks.get(fact.request.taskId);
      if (track) this.#observe(track, 'approval_requested', 'waiting', 'approval');
      return;
    }
    if (fact.type === 'task_question_opened') {
      const track = this.#tracks.get(fact.taskId);
      if (track) this.#observe(track, 'question_asked', 'waiting', 'answer');
      return;
    }
    if (fact.type === 'task_stop_requested') {
      const track = this.#tracks.get(fact.taskId);
      if (track) this.#observe(track, 'stop_requested', 'cancelling');
      return;
    }
    if (fact.type !== 'branch_event') return;
    const track = this.#tracks.get(fact.branchId);
    if (track?.kind !== 'subagent') return;
    const event = fact.fact;
    if (event.type === 'text_delta') {
      this.#observe(track, track.inStream ? 'text_received' : 'response_started', 'active');
      track.inStream = true;
      track.currentText = `${track.currentText}${event.delta}`.slice(0, PEEK_TEXT_CHARS);
    } else if (event.type === 'item' && event.item.type === 'assistant_message') {
      this.#observe(track, 'text_received', 'active');
      const text = event.item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
      if (text) track.lastTurnText = text.slice(0, PEEK_TEXT_CHARS);
      track.currentText = '';
    } else if (event.type === 'item' && event.item.type === 'tool_call') {
      track.inStream = true;
      this.#observe(track, 'tool_input_received', 'active');
    } else if (event.type === 'tool_started') {
      track.inStream = false;
      this.#observe(track, 'tool_started', 'active');
      track.toolCounts.set(event.toolName, (track.toolCounts.get(event.toolName) ?? 0) + 1);
      track.lastToolName = toolLabel(event.toolName);
    } else if (event.type === 'tool_finished') {
      track.inStream = false;
      this.#observe(track, 'tool_completed', 'waiting', 'provider');
    }
  }

  /** A chunk of a shell task's output. */
  shellOutput(taskId: string, chunk: string): void {
    const track = this.#tracks.get(taskId);
    if (track?.kind !== 'shell') return;
    track.observation = { kind: 'shell_output_received', at: this.#now() };
    track.outputTail = `${track.outputTail}${chunk}`.slice(-SHELL_TAIL_CHARS);
  }

  /** Legacy's check-in details for a running task (background-check-in-scheduler.ts). */
  details(task: DirectTaskState): DirectTaskActivityDetails {
    const track = this.#tracks.get(task.taskId);
    if (!track) return {};
    const now = this.#now();
    if (task.kind === 'shell') {
      const tail = track.outputTail.trim();
      return {
        activity: activity('active', undefined, track.observation.at, now, SHELL_QUIET_AFTER_MS),
        ...(tail ? { outputTail: tail } : {}),
      };
    }
    const waiting =
      task.status === 'waiting_for_answer'
        ? 'answer'
        : task.pendingInteractions.length > 0
        ? 'approval'
        : track.state === 'waiting'
        ? track.reason
        : undefined;
    const phase = task.status === 'cancelling' ? 'cancelling' : waiting ? 'waiting' : track.state;
    const narrative = track.currentText.trim() || track.lastTurnText?.trim();
    const latestNarrative = narrative ? preview(narrative) : undefined;
    return {
      activity: activity(phase, waiting, track.observation.at, now, SUBAGENT_QUIET_AFTER_MS),
      activityState: track.state,
      ...(track.state === 'waiting' && track.reason ? { waitingReason: track.reason } : {}),
      ...(track.toolCounts.size ? { toolCounts: Object.fromEntries(track.toolCounts) } : {}),
      ...(track.lastToolName ? { lastToolName: track.lastToolName } : {}),
      ...(latestNarrative ? { latestNarrative } : {}),
    };
  }
}

function activity(
  phase: 'active' | 'waiting' | 'cancelling',
  reason: Track['reason'],
  at: number,
  now: number,
  quietAfterMs: number,
): NonNullable<DirectTaskActivityDetails['activity']> {
  const ageMs = Math.max(0, now - at);
  return {
    phase,
    ...(phase === 'waiting' && reason ? { reason } : {}),
    liveness: { state: ageMs >= quietAfterMs ? 'quiet' : 'recent', ageMs },
  };
}

/** Legacy's sanitizeBackgroundTaskToolLabel. */
function toolLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > TOOL_LABEL_LIMIT ? `${normalized.slice(0, TOOL_LABEL_LIMIT - 1)}…` : normalized;
}

/** Legacy's truncatePreview: the first paragraph on one line, at most 300 characters. */
function preview(text: string): string {
  const first =
    text
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() || '';
  return first.length <= 300 ? first : `${first.slice(0, 297)}...`;
}
