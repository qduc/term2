// Concise-mode presentation layer that folds a run of consecutive tool-call
// messages into a single live summary line (e.g. "Searched for 1 pattern, read
// 3 files, ran 2 shell commands").
//
// In an open trailing run, the most recently completed tool call is retained
// separate below the group summary line so its result stays visible while work
// proceeds. Preceding finished calls collapse into the summary line whose counts
// tick up in place. Once another kind of message arrives (or the run closes),
// all settled calls fold into the group summary.
//
// That bound matters beyond looks. An ungrouped run grows the dynamic region by
// ~2 rows per tool call, and once that region reaches the terminal height Ink
// stops redrawing incrementally and clears the screen *and the scrollback* on
// every frame. Only the last run call and in-flight calls stay unfolded, and
// those are bounded.
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { formatToolArgs } from './command-message-helpers.js';

export type GroupableMessage = {
  id: string;
  sender?: string;
  status?: string;
  success?: boolean | null;
  toolName?: string;
  command?: string;
  toolArgs?: any;
  role?: string;
  task?: string;
  parentTool?: string;
  async?: boolean;
  tools?: any[];
  finalText?: string;
  error?: string;
};

export type CommandGroupMessage = {
  id: string;
  sender: 'command-group';
  status: 'completed' | 'partial' | 'failed';
  members: GroupableMessage[];
};

export const isGroupableMessage = (message: GroupableMessage | undefined): boolean =>
  message?.sender === 'command' || message?.sender === 'subagent';

const isRunningStatus = (status: string | undefined) => status === 'pending' || status === 'running';

const isFailedMember = (message: GroupableMessage) =>
  message.status === 'failed' ||
  message.status === 'aborted' ||
  message.status === 'cancelled' ||
  message.status === 'interrupted' ||
  message.success === false;

export const countFailedMembers = (members: GroupableMessage[]): number => members.filter(isFailedMember).length;

const MAX_FAILURE_LABEL_CHARS = 40;
const MAX_NAMED_FAILURES = 3;

/** Shortest thing that identifies one call: the subagent title, shell command, else its formatted args, else the tool name. */
const describeMember = (member: GroupableMessage): string => {
  if (member.sender === 'subagent') {
    const toolName = member.toolName ?? member.parentTool ?? (member.async ? 'run_subagent_async' : 'run_subagent');
    const roleLabel = member.role ? ` [${member.role}]` : '';
    const raw = `${toolName}${roleLabel}`;
    return raw.length > MAX_FAILURE_LABEL_CHARS ? `${raw.slice(0, MAX_FAILURE_LABEL_CHARS - 1)}…` : raw;
  }
  const isShell = !member.toolName || member.toolName === 'shell';
  const raw = isShell
    ? member.command ?? ''
    : (member.toolArgs ? formatToolArgs(member.toolName, member.toolArgs, 'concise') : '') || member.toolName || '';
  const firstLine = raw.split('\n')[0].trim();

  return firstLine.length > MAX_FAILURE_LABEL_CHARS ? `${firstLine.slice(0, MAX_FAILURE_LABEL_CHARS - 1)}…` : firstLine;
};

/**
 * "2 failed: pnpm test, git push" — the line that sits under a partly-failed
 * group. Naming the failures is the whole point of the second line, so it is
 * capped rather than allowed to wrap into a paragraph.
 */
export const describeGroupFailures = (members: GroupableMessage[]): string => {
  const failed = members.filter(isFailedMember);
  if (failed.length === 0) {
    return '';
  }

  const labels = failed.slice(0, MAX_NAMED_FAILURES).map(describeMember).filter(Boolean);
  const unnamed = failed.length - labels.length;
  const named = labels.join(', ');
  const suffix = unnamed > 0 ? `${named ? ', ' : ''}+${unnamed} more` : '';

  return `${failed.length} failed${named || suffix ? `: ${named}${suffix}` : ''}`;
};

/**
 * The id keys on the *first* member only, so it stays stable as the run grows.
 * A growing run must keep one identity across renders, or every new tool call
 * would remount the summary line and could commit a stale copy to <Static>.
 */
export const buildCommandGroupMessage = (members: GroupableMessage[]): CommandGroupMessage => {
  const failed = countFailedMembers(members);
  // `failed` means the whole run failed. A run where only some calls failed is
  // `partial`: painting the whole line red would claim work failed that
  // actually succeeded, which is most of what the run did.
  const status = failed === 0 ? 'completed' : failed === members.length ? 'failed' : 'partial';

  return {
    id: `command-group:${members[0].id}`,
    sender: 'command-group',
    status,
    members,
  };
};

export type GroupCommandRunsOptions = {
  /** When true, all runs in the message list are treated as closed (e.g. in static history). */
  isClosed?: boolean;
};

/**
 * Within each maximal run of consecutive `sender === 'command'` messages, folds
 * settled calls into a `CommandGroupMessage`.
 *
 * In an open trailing run (where no subsequent non-command message has arrived),
 * the most recently completed tool call is retained separate below the group
 * summary line so its result stays visible. Once another kind of message
 * arrives, all settled calls in the run fold into the group.
 *
 * Anything from the first still-running call onward is left alone, so work in
 * flight keeps showing what it is doing. Everything else passes through
 * unchanged.
 *
 * A single settled call in an open trailing run is left alone so its result
 * stays visible while work may continue. Once another kind of message closes
 * the run, even one call folds into the summary line.
 */
export const groupCommandRuns = <T extends GroupableMessage>(
  messages: T[],
  options?: GroupCommandRunsOptions,
): (T | CommandGroupMessage)[] => {
  const result: (T | CommandGroupMessage)[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    if (!isGroupableMessage(message)) {
      result.push(message);
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < messages.length && isGroupableMessage(messages[j])) {
      j += 1;
    }

    const run = messages.slice(i, j);
    const hasTrailingNonCommandMessage = options?.isClosed || j < messages.length;
    const inFlight = run.findIndex((member) => isRunningStatus(member.status));
    const settled = inFlight === -1 ? run : run.slice(0, inFlight);
    const inFlightAndAfter = inFlight === -1 ? [] : run.slice(inFlight);

    if (hasTrailingNonCommandMessage) {
      if (settled.length >= 1) {
        result.push(buildCommandGroupMessage(settled), ...inFlightAndAfter);
      } else {
        result.push(...run);
      }
    } else {
      if (settled.length >= 2) {
        const lastRunTool = settled[settled.length - 1];
        const toGroup = settled.slice(0, -1);
        result.push(buildCommandGroupMessage(toGroup), lastRunTool, ...inFlightAndAfter);
      } else {
        result.push(...run);
      }
    }

    i = j;
  }

  return result;
};

type ToolGroupCategory = { verb: string; singular: string; plural: string };

const TOOL_GROUP_CATEGORIES: Record<string, ToolGroupCategory> = {
  shell: { verb: 'Ran', singular: 'shell command', plural: 'shell commands' },
  grep: { verb: 'Searched for', singular: 'pattern', plural: 'patterns' },
  glob: { verb: 'Searched for', singular: 'file pattern', plural: 'file patterns' },
  read_file: { verb: 'Read', singular: 'file', plural: 'files' },
  view_file: { verb: 'Read', singular: 'file', plural: 'files' },
  [TOOL_NAME_APPLY_PATCH]: { verb: 'Patched', singular: 'file', plural: 'files' },
  [TOOL_NAME_SEARCH_REPLACE]: { verb: 'Edited', singular: 'file', plural: 'files' },
  [TOOL_NAME_CREATE_FILE]: { verb: 'Created', singular: 'file', plural: 'files' },
  web_search: { verb: 'Searched the web for', singular: 'query', plural: 'queries' },
  web_fetch: { verb: 'Fetched', singular: 'page', plural: 'pages' },
  read_code_outline: { verb: 'Read', singular: 'code outline', plural: 'code outlines' },
  code_context_search: { verb: 'Searched context for', singular: 'query', plural: 'queries' },
  run_subagent: { verb: 'Delegated to', singular: 'subagent', plural: 'subagents' },
  run_subagent_async: { verb: 'Delegated async to', singular: 'subagent', plural: 'subagents' },
  ask_user: { verb: 'Asked user', singular: 'question', plural: 'questions' },
  ask_mentor: { verb: 'Asked mentor', singular: 'question', plural: 'questions' },
};

const DEFAULT_TOOL_GROUP_CATEGORY: ToolGroupCategory = { verb: 'Ran', singular: 'tool call', plural: 'tool calls' };

const lowerFirst = (text: string) => (text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** Builds "Searched for 1 pattern, read 3 files, ran 2 shell commands" from a closed group's members. */
export const summarizeCommandGroup = (
  members: { toolName?: string; sender?: string; parentTool?: string; async?: boolean }[],
): string => {
  const order: string[] = [];
  const counts = new Map<string, number>();

  for (const member of members) {
    let key = member.toolName;
    if (!key) {
      if (member.sender === 'subagent') {
        key = member.parentTool ?? (member.async ? 'run_subagent_async' : 'run_subagent');
      } else {
        key = 'shell';
      }
    }
    if (!counts.has(key)) {
      order.push(key);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return order
    .map((key, idx) => {
      const count = counts.get(key) ?? 0;
      const category = TOOL_GROUP_CATEGORIES[key] ?? DEFAULT_TOOL_GROUP_CATEGORY;
      const noun = count === 1 ? category.singular : category.plural;
      const verb = idx === 0 ? category.verb : lowerFirst(category.verb);
      return `${verb} ${count} ${noun}`;
    })
    .join(', ');
};
