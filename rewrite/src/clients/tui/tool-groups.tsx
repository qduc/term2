import React from 'react';
import CommandGroupSummary from './presentation/components/message/CommandGroupSummary.js';
import {
  groupCommandRuns,
  type CommandGroupMessage,
  type GroupableMessage,
} from './presentation/components/message/command-grouping.js';
import type { ToolView } from './state.js';
import type { JsonValue } from '../../protocol/direct-wire.js';

export type ToolGroup = { readonly members: GroupableMessage[]; readonly status: CommandGroupMessage['status'] };
/** A group's summary hangs on its first tool; every other member is `null` (drawn by the summary). */
export type ToolGroups = ReadonlyMap<string, ToolGroup | null>;

function groupable(tool: ToolView): GroupableMessage {
  const display = tool.display;
  const messages = Array.isArray(display)
    ? display
    : display && typeof display === 'object' && Array.isArray((display as { messages?: JsonValue }).messages)
    ? ((display as { messages: JsonValue[] }).messages as JsonValue[])
    : [];
  const first = messages.find(
    (message): message is Record<string, JsonValue> =>
      typeof message === 'object' && message !== null && !Array.isArray(message) && message.sender === 'command',
  );
  const failed = tool.status === 'rejected' || (tool.status === 'failed' && first !== undefined);
  return {
    id: tool.id,
    sender: 'command',
    status: tool.outcomeUnknown
      ? 'unknown'
      : tool.status === 'rejected'
      ? 'failed'
      : tool.status === 'failed' && !first
      ? 'completed'
      : tool.status,
    ...(failed ? { success: false } : typeof first?.success === 'boolean' ? { success: first.success } : {}),
    toolName: tool.name,
    command: typeof first?.command === 'string' ? first.command : '',
    toolArgs: tool.input,
  };
}

/**
 * Legacy's concise-mode grouping of consecutive tool calls (`groupCommandRuns`), over the timeline's
 * order. `closed` treats the last run as finished, as legacy does for committed history.
 */
export function groupTools(
  timeline: readonly { readonly kind: 'message' | 'tool'; readonly id: string }[],
  tools: readonly ToolView[],
  closed: boolean,
  shownAt?: ReadonlyMap<string, number>,
): ToolGroups {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const items: GroupableMessage[] = [];
  let run: ToolView[] = [];
  // Legacy lists a run in the order its rows appeared: a call that waited on the user only once decided.
  const at = (tool: ToolView) => shownAt?.get(tool.id) ?? Number.MAX_SAFE_INTEGER;
  const flush = () => {
    items.push(...[...run].sort((a, b) => at(a) - at(b)).map(groupable));
    run = [];
  };
  for (const entry of timeline) {
    const tool = entry.kind === 'tool' ? byId.get(entry.id) : undefined;
    if (tool) {
      run.push(tool);
      continue;
    }
    flush();
    items.push({ id: `${entry.kind}:${entry.id}`, sender: 'bot' });
  }
  flush();
  const result = new Map<string, ToolGroup | null>();
  for (const item of groupCommandRuns(items, { isClosed: closed })) {
    if (item.sender !== 'command-group') continue;
    const group = item as CommandGroupMessage;
    group.members.forEach((member, index) =>
      result.set(member.id, index === 0 ? { members: group.members, status: group.status } : null),
    );
  }
  return result;
}

export function ToolGroupRow({ group }: { readonly group: ToolGroup }): React.ReactElement {
  return <CommandGroupSummary members={group.members} status={group.status} />;
}
