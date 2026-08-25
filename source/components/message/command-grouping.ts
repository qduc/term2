// Concise-mode presentation layer that folds a *closed* run of consecutive
// tool-call messages into a single summary line (e.g. "Searched for 1
// pattern, read 3 files, ran 2 shell commands").
//
// A run is "closed" when we know for certain no further tool call will be
// appended immediately after it — either because a different kind of message
// already followed it, or (for the tail of static history specifically) the
// caller has already established that via `treatTrailingAsClosed`. A run
// sitting at the very end of the live/dynamic region is always left
// ungrouped: more tool calls could still land right after it, and a group
// already committed to Ink's <Static> can never be edited once written, so
// grouping must never guess ahead of what's actually known.
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

export type GroupableMessage = {
  id: string;
  sender?: string;
  status?: string;
  success?: boolean | null;
  toolName?: string;
};

export type CommandGroupMessage = {
  id: string;
  sender: 'command-group';
  status: 'completed' | 'failed';
  members: GroupableMessage[];
};

const isTerminalStatus = (status: string | undefined) => status !== 'pending' && status !== 'running';

const isFailedMember = (message: GroupableMessage) =>
  message.status === 'failed' || message.status === 'aborted' || message.success === false;

export const buildCommandGroupMessage = (members: GroupableMessage[]): CommandGroupMessage => {
  const first = members[0];
  const last = members[members.length - 1];
  return {
    id: `command-group:${first.id}:${last.id}`,
    sender: 'command-group',
    status: members.some(isFailedMember) ? 'failed' : 'completed',
    members,
  };
};

/**
 * Folds maximal runs of consecutive `sender === 'command'` messages (length
 * >= 2, all terminal) into a single `CommandGroupMessage`. Everything else
 * passes through unchanged.
 *
 * `treatTrailingAsClosed` controls whether a run touching the end of the
 * given array counts as closed. Pass `true` only when the caller has
 * separately confirmed (outside this array) that nothing more will be
 * appended right after it — e.g. static history, where a later active
 * message already proved the run is over. Pass `false` for the live/dynamic
 * region, where a trailing run may still be growing.
 */
export const groupCommandRuns = <T extends GroupableMessage>(
  messages: T[],
  options: { treatTrailingAsClosed: boolean },
): (T | CommandGroupMessage)[] => {
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
    const isTrailingRun = j === messages.length;
    const allTerminal = run.every((m) => isTerminalStatus(m.status));
    const shouldGroup = run.length >= 2 && allTerminal && (!isTrailingRun || options.treatTrailingAsClosed);

    if (shouldGroup) {
      result.push(buildCommandGroupMessage(run));
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

export const countFailedMembers = (members: GroupableMessage[]): number => members.filter(isFailedMember).length;
