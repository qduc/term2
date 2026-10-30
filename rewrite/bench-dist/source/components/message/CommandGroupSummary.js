import React from 'react';
import { describeGroupFailures, summarizeCommandGroup } from './command-grouping.js';
import { useSkin } from '../../skins/SkinContext.js';
/**
 * Concise-mode line(s) for a run of tool calls, e.g. "Searched for 1 pattern,
 * read 3 files, ran 2 shell commands". This owns the grouping data; how the line
 * is drawn belongs to the active skin.
 */
const CommandGroupSummary = ({ members, status }) => {
    const { ToolGroupSummary } = useSkin();
    return (React.createElement(ToolGroupSummary, { status: status, summary: summarizeCommandGroup(members), failures: describeGroupFailures(members) }));
};
export default React.memo(CommandGroupSummary);
//# sourceMappingURL=CommandGroupSummary.js.map