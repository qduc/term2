// Concise-mode presentation layer that folds a run of consecutive tool-call
// messages into a single live summary line (e.g. "Searched for 1 pattern, read
// 3 files, ran 2 shell commands").
//
// Grouping is eager: a run collapses as soon as it has two members, while more
// tool calls may still be appended to it and while a member is still running.
// The counts simply tick up in place. That keeps the run one line tall for its
// whole lifetime, which matters beyond looks — an ungrouped run grows the
// dynamic region by ~2 rows per tool call, and once that region reaches the
// terminal height Ink stops redrawing incrementally and clears the screen *and
// the scrollback* on every frame.
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
  status: 'running' | 'completed' | 'failed';
  members: GroupableMessage[];
};

const isRunningStatus = (status: string | undefined) => status === 'pending' || status === 'running';

const isFailedMember = (message: GroupableMessage) =>
  message.status === 'failed' || message.status === 'aborted' || message.success === false;

/**
 * The id keys on the *first* member only, so it stays stable as the run grows.
 * A growing run must keep one identity across renders, or every new tool call
 * would remount the summary line and could commit a stale copy to <Static>.
 */
export const buildCommandGroupMessage = (members: GroupableMessage[]): CommandGroupMessage => {
  const status = members.some((member) => isRunningStatus(member.status))
    ? 'running'
    : members.some(isFailedMember)
    ? 'failed'
    : 'completed';

  return {
    id: `command-group:${members[0].id}`,
    sender: 'command-group',
    status,
    members,
  };
};

/**
 * Folds every maximal run of 2+ consecutive `sender === 'command'` messages
 * into a single `CommandGroupMessage`, whether or not the run is finished.
 * Everything else passes through unchanged.
 *
 * A lone command is left alone so a single tool call still shows what it
 * actually did rather than a bare "1 file".
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

    if (run.length >= 2) {
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
