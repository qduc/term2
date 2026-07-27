/**
 * Which agent a pending tool call belongs to. Drives whether an approval and
 * its tool lifecycle events are rendered against the main conversation or
 * against a subagent's card.
 */
export type ToolOwner =
  | { kind: 'parent' }
  | {
      kind: 'subagent';
      agentId: string;
      role: string;
    };

export const PARENT_TOOL_OWNER: ToolOwner = { kind: 'parent' };
