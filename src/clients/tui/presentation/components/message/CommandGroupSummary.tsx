import React, { FC } from 'react';
import { describeGroupFailures, summarizeCommandGroup, type GroupableMessage } from './command-grouping.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  members: GroupableMessage[];
  status: 'completed' | 'partial' | 'failed';
};

/**
 * Concise-mode line(s) for a run of tool calls, e.g. "Searched for 1 pattern,
 * read 3 files, ran 2 shell commands". This owns the grouping data; how the line
 * is drawn belongs to the active skin.
 */
const CommandGroupSummary: FC<Props> = ({ members, status }) => {
  const { ToolGroupSummary } = useSkin();
  return (
    <ToolGroupSummary
      status={status}
      summary={summarizeCommandGroup(members)}
      failures={describeGroupFailures(members)}
    />
  );
};

export default React.memo(CommandGroupSummary);
