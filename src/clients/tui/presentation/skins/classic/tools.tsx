import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import type { ToolFrameProps, ToolGroupSummaryView, ToolHeaderProps } from '../types.js';
import type { ToolStatusKind } from '../../theme/palettes.js';

/** Tool output is printed bare in the classic skin; the frame is the seam other skins draw around it. */
export const ClassicToolFrame: FC<ToolFrameProps> = ({ children }) => <>{children}</>;

const IN_FLIGHT: ReadonlySet<ToolStatusKind> = new Set(['pending', 'running']);

/**
 * One header line. Standard mode and in-flight calls colour the whole line by
 * status; settled concise calls colour only the marker and leave the text muted,
 * so a transcript of finished calls stays quiet and a failure stands out.
 */
export const ClassicToolHeader: FC<ToolHeaderProps> = ({
  status,
  display,
  nested,
  action,
  meta,
  trailing,
  textColor,
}) => {
  const theme = useTheme();
  const color = theme.toolStatus[status];
  const glyph = TOOL_STATUS_GLYPH[status];

  if (display === 'standard') {
    return (
      <Box>
        <Text color={color}>
          {glyph} {action}
          {meta}
        </Text>
      </Box>
    );
  }

  if (nested) {
    return (
      <Box>
        <Text wrap="truncate" color={theme.textSubtle}>
          <Text color={color}>{glyph}</Text> {action}
          {meta}
        </Text>
      </Box>
    );
  }

  if (IN_FLIGHT.has(status)) {
    return (
      <Box>
        <Text color={color}>
          <Text bold>{glyph}</Text> {action}
          {meta}
          {trailing}
        </Text>
      </Box>
    );
  }

  return (
    <Text color={textColor || theme.textMuted}>
      <Text color={color} bold>
        {glyph}
      </Text>{' '}
      {action}
      {trailing}
    </Text>
  );
};

const GROUP_MARKER_KIND: Record<ToolGroupSummaryView['status'], ToolStatusKind> = {
  completed: 'completed',
  partial: 'completed',
  failed: 'failed',
};

/**
 * Concise-mode line(s) for a run of tool calls. A partly-failed run keeps a green
 * marker and neutral summary: most of what it did succeeded, and painting the whole
 * line red would claim otherwise. The red marker underneath carries the bad news and
 * names the calls that failed, so the count is actionable without painting the whole
 * line red.
 */
export const ClassicToolGroupSummary: FC<ToolGroupSummaryView> = ({ status, summary, failures }) => {
  const theme = useTheme();
  const kind = GROUP_MARKER_KIND[status];

  return (
    <Box flexDirection="column">
      <Text color={theme.textMuted} wrap="truncate">
        <Text color={theme.toolStatus[kind]} bold>
          {TOOL_STATUS_GLYPH[kind]}
        </Text>{' '}
        {summary}
      </Text>
      {failures !== '' && status !== 'failed' && (
        <Text color={theme.textMuted} wrap="truncate">
          <Text color={theme.toolStatus.failed} bold>
            {TOOL_STATUS_GLYPH.failed}
          </Text>{' '}
          {failures}
        </Text>
      )}
    </Box>
  );
};
