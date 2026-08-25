// Concise-mode presentation layer that folds a run of consecutive tool-call
// messages into a single live summary line (e.g. "Searched for 1 pattern, read
// 3 files, ran 2 shell commands").
//
// Grouping is eager: the finished calls in a run collapse as soon as there are
// two of them, while more calls may still be appended. The counts simply tick
// up in place. Calls still in flight keep their own detailed line below the
// group, so a slow one is visible for as long as it runs.
//
// That bound matters beyond looks. An ungrouped run grows the dynamic region by
// ~2 rows per tool call, and once that region reaches the terminal height Ink
// stops redrawing incrementally and clears the screen *and the scrollback* on
// every frame. Only the in-flight calls stay unfolded, and those are capped by
// the parallel-dispatch limit.
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
};

export type CommandGroupMessage = {
  id: string;
  sender: 'command-group';
  status: 'completed' | 'partial' | 'failed';
  members: GroupableMessage[];
};

const isRunningStatus = (status: string | undefined) => status === 'pending' || status === 'running';

const isFailedMember = (message: GroupableMessage) =>
  message.status === 'failed' || message.status === 'aborted' || message.success === false;

export const countFailedMembers = (members: GroupableMessage[]): number => members.filter(isFailedMember).length;

const MAX_FAILURE_LABEL_CHARS = 40;
const MAX_NAMED_FAILURES = 3;

/** Shortest thing that identifies one call: the shell command, else its formatted args, else the tool name. */
const describeMember = (member: GroupableMessage): string => {
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

/**
 * Within each maximal run of consecutive `sender === 'command'` messages, folds
 * the leading *settled* calls into one `CommandGroupMessage`. Anything from the
 * first still-running call onward is left alone, so work in flight keeps
 * showing what it is doing. Everything else passes through unchanged.
 *
 * A single settled call is also left alone, so one tool call still shows what
 * it actually did rather than a bare "1 file".
 */
export const groupCommandRuns = <T extends GroupableMessage>(messages: T[]): (T | CommandGroupMessage)[] => {
  const result: (T | CommandGroupMessage)[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    if (message.sender !== 'command') {
      result.push(message);
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < messages.length && messages[j].sender === 'command') {
      j += 1;
    }

    const run = messages.slice(i, j);
    const inFlight = run.findIndex((member) => isRunningStatus(member.status));
    const settled = inFlight === -1 ? run : run.slice(0, inFlight);

    if (settled.length >= 2) {
      result.push(buildCommandGroupMessage(settled), ...run.slice(settled.length));
    } else {
      result.push(...run);
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
export const summarizeCommandGroup = (members: { toolName?: string }[]): string => {
  const order: string[] = [];
  const counts = new Map<string, number>();

  for (const member of members) {
    const key = member.toolName || 'shell';
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
