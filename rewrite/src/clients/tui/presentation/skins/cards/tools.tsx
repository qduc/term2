import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import type { Color, ToolStatusKind } from '../../theme/palettes.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import type { ToolFrameProps, ToolGroupSummaryView, ToolHeaderProps } from '../types.js';
import { Card, type CardShape } from './card.js';

/** Only a running call animates, and only this component ticks, so settled output costs no timers. */
const RunningGlyph: FC<{ color: Color }> = ({ color }) => {
  const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
  return (
    <Text color={color} bold>
      {frame}
    </Text>
  );
};

/** The status marker: a spinner while running, otherwise the shared glyph for the status. */
const StatusGlyph: FC<{ status: ToolStatusKind }> = ({ status }) => {
  const theme = useTheme();
  const color = theme.toolStatus[status];
  if (status === 'running') return <RunningGlyph color={color} />;
  return (
    <Text color={color} bold>
      {TOOL_STATUS_GLYPH[status]}
    </Text>
  );
};

/** A failed or refused call gets a heavier border, so it stands out without relying on red. */
const shapeFor = (status: ToolStatusKind): CardShape =>
  status === 'failed' || status === 'rejected' ? 'bold' : 'round';

/**
 * Standard display only: the header and the full output share one rounded card whose
 * border is the status colour. Concise calls stay single bare lines, so a long run of
 * calls reads as a list rather than a wall of boxes.
 */
export const CardsToolFrame: FC<ToolFrameProps> = ({ status, display, children }) => {
  const theme = useTheme();
  if (display !== 'standard') return <>{children}</>;
  return (
    <Card color={theme.toolStatus[status]} shape={shapeFor(status)}>
      {children}
    </Card>
  );
};

const IN_FLIGHT: ReadonlySet<ToolStatusKind> = new Set(['pending', 'running']);

/** The tool's own name labels a call unless the action already is the command. */
const isShellLike = (toolName: string | undefined): boolean => toolName === undefined || toolName === 'shell';

/**
 * The first row of a card: status glyph, then the tool name and action, with the
 * glyph in its own column so a long command wraps underneath the action rather than
 * under the glyph. Settled concise calls colour only the glyph and keep the text quiet.
 */
export const CardsToolHeader: FC<ToolHeaderProps> = ({
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

  if (display === 'standard') {
    return (
      <Box>
        <Box flexShrink={0} marginRight={1}>
          <StatusGlyph status={status} />
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          <Text>
            {!isShellLike(toolName) && <Text color={theme.textSubtle}>{toolName} </Text>}
            {action}
            {meta}
            {trailing}
          </Text>
        </Box>
      </Box>
    );
  }

  if (nested) {
    return (
      <Box>
        <Text wrap="truncate" color={theme.textSubtle}>
          <StatusGlyph status={status} /> {action}
          {meta}
        </Text>
      </Box>
    );
  }

  if (IN_FLIGHT.has(status)) {
    return (
      <Box>
        <Text>
          <StatusGlyph status={status} /> {action}
          {meta}
          {trailing}
        </Text>
      </Box>
    );
  }

  return (
    <Text color={textColor || theme.textMuted}>
      <StatusGlyph status={status} /> {action}
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
 * One line for a run of calls. A partly-failed run keeps the neutral summary and the
 * green marker, because most of what it did succeeded; the failure line beneath, with
 * its own red marker, is what carries the bad news. Both lines wrap rather than clip.
 */
export const CardsToolGroupSummary: FC<ToolGroupSummaryView> = ({ status, summary, failures }) => {
  const theme = useTheme();
  const kind = GROUP_MARKER_KIND[status];
  return (
    <Box flexDirection="column">
      <Text color={theme.textMuted}>
        <StatusGlyph status={kind} /> {summary}
      </Text>
      {failures !== '' && status !== 'failed' && (
        <Text color={theme.textMuted}>
          <StatusGlyph status="failed" /> {failures}
        </Text>
      )}
    </Box>
  );
};
