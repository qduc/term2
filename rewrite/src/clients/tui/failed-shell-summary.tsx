import React from 'react';
import { Text } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import type { ToolView } from './state.js';
import { reportsFailure } from './tool-view.js';

/** Group only settled shell failures from the same known turn. */
export function failedShellGroups(tools: readonly ToolView[]): Map<string, number> {
  const turns = new Map<string, ToolView[]>();
  for (const tool of tools) {
    if (
      !tool.turnId ||
      tool.name !== 'shell' ||
      tool.outcomeUnknown ||
      (tool.status !== 'failed' && !(tool.status === 'completed' && reportsFailure(tool.display)))
    )
      continue;
    const group = turns.get(tool.turnId) ?? [];
    group.push(tool);
    turns.set(tool.turnId, group);
  }
  const result = new Map<string, number>();
  for (const group of turns.values())
    if (group.length > 1) {
      group.forEach((tool, index) => result.set(tool.id, index === 0 ? group.length : 0));
    }
  return result;
}

export function FailedShellSummary({ count }: { readonly count: number }): React.ReactElement {
  const theme = useTheme();
  return <Text color={theme.danger}>{count} commands failed · Ctrl+O for details</Text>;
}
