import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import type { ToolStatusKind } from '../../theme/palettes.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { ToolFrameProps, ToolGroupSummaryView, ToolHeaderProps } from '../types.js';
import { RAIL_HEAVY, RAIL_THIN, Rail } from './parts.js';

/**
 * The status glyph. A running call shows a spinner instead of the static `◐`;
 * the hook lives here, the smallest component that draws the glyph, and only
 * ticks while the call is actually running.
 */
const ToolGlyph: FC<{ status: ToolStatusKind }> = ({ status }) => {
  const theme = useTheme();
  const frame = useSpinnerFrame(BRAILLE_SPINNER, status === 'running');
  return (
    <Text color={theme.toolStatus[status]} bold>
      {status === 'running' ? frame : TOOL_STATUS_GLYPH[status]}
    </Text>
  );
};

/**
 * Standard display: a thin rail, coloured by status, down the whole call so the
 * output reads as belonging to its header. A failed call gets a heavier rail, so it
 * differs in shape and not only in colour.
 *
 * Concise calls are single lines and stay bare, except a failed one: its error
 * text follows the header as extra lines, and the rail is what ties them to it
 * (and makes a failure the one thing in a quiet transcript that is indented).
 */
export const RailToolFrame: FC<ToolFrameProps> = ({ status, display, children }) => {
  const theme = useTheme();
  const failed = status === 'failed' || status === 'rejected';
  if (display !== 'standard' && !failed) return <>{children}</>;
  return (
    <Rail glyph={failed ? RAIL_HEAVY : RAIL_THIN} color={theme.toolStatus[status]}>
      {children}
    </Rail>
  );
};

/**
 * Glyph, the tool's name in muted type, then the action. The name is shown for
 * standard calls and for shell commands, where a bare command would otherwise have
 * no label; in concise mode the other tools' actions already begin with a verb
 * ("Read", "Searched") and a second label would only cost columns.
 *
 * The text wraps under the action, not under the glyph, so a long command stays
 * a block.
 */
export const RailToolHeader: FC<ToolHeaderProps> = ({
  status,
  display,
  toolName,
  nested,
  action,
  meta,
  trailing,
  textColor,
}) => {
  const theme = useTheme();

  if (nested) {
    return (
      <Box>
        <Text wrap="truncate" color={theme.textSubtle}>
          <Text color={theme.toolStatus[status]} bold>
            {TOOL_STATUS_GLYPH[status]}
          </Text>{' '}
          {action}
          {meta}
        </Text>
      </Box>
    );
  }

  const isShell = toolName === undefined || toolName === 'shell';
  const label = display === 'standard' || isShell ? toolName ?? 'shell' : undefined;

  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <ToolGlyph status={status} />
      </Box>
      <Box flexShrink={1}>
        <Text color={textColor}>
          {label && <Text color={theme.textSubtle}>{label} </Text>}
          {action}
          {meta}
          {trailing}
        </Text>
      </Box>
    </Box>
  );
};

const GROUP_MARKER_KIND: Record<ToolGroupSummaryView['status'], ToolStatusKind> = {
  completed: 'completed',
  partial: 'completed',
  failed: 'failed',
};

const SummaryLine: FC<{ kind: ToolStatusKind; text: string }> = ({ kind, text }) => {
  const theme = useTheme();
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={theme.toolStatus[kind]} bold>
          {TOOL_STATUS_GLYPH[kind]}
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={theme.textSubtle}>{text}</Text>
      </Box>
    </Box>
  );
};

/**
 * One quiet line for a run of calls. A partly-failed run keeps its green marker,
 * because most of it succeeded; the line below carries the bad news.
 */
export const RailToolGroupSummary: FC<ToolGroupSummaryView> = ({ status, summary, failures }) => (
  <Box flexDirection="column">
    <SummaryLine kind={GROUP_MARKER_KIND[status]} text={summary} />
    {failures !== '' && status !== 'failed' && <SummaryLine kind="failed" text={failures} />}
  </Box>
);
