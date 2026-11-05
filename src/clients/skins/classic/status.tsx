import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SELECTED, GLYPH_SEPARATOR, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { terminalTextWidth, truncateTerminalText } from '../../components/layout/terminal-text-budget.js';
import type { StatusAlertView, StatusSegmentView, StatusView } from '../types.js';

/**
 * The one separator used between top-level config segments. Spacing lives
 * here so every gap is identical; previously the same `│` was written three
 * different ways (bare, inside `marginX`, and padded) and the bar looked
 * ragged.
 */
const Divider: FC = () => {
  const theme = useTheme();
  return <Text color={theme.textSubtle}> {GLYPH_SEPARATOR} </Text>;
};

/** The separator used between metrics segments — a lighter join than the `│`
 * used elsewhere, since the metrics group is already one visual cluster. */
const MetricDivider: FC = () => {
  const theme = useTheme();
  return <Text color={theme.textSubtle}> · </Text>;
};

// terminalTextWidth counts every codepoint above U+007F as 2 columns, which is
// the right conservative default for CJK/emoji text but wildly overcounts the
// narrow box-drawing and arrow glyphs this bar is built from (│ ↑ ↓ · ▲ ❯ …).
// Measuring those as 2 nearly doubles the bar's apparent width and makes the
// budget collapse into the narrow layout far too eagerly. These specific
// glyphs render as exactly one cell in every terminal this app targets (they
// are chosen from theme.ts's "single-width on purpose" set plus the ellipsis
// truncateTerminalText appends), so measure them at 1 and defer to
// terminalTextWidth for everything else. Fix it here, not in
// terminalTextWidth itself — other callers of that function rely on its
// conservative doubling for content that really can be double-width.
const STATUS_BAR_NARROW_GLYPHS = new Set([GLYPH_SEPARATOR, '↑', '↓', '→', '·', GLYPH_WARNING, GLYPH_SELECTED, '…']);

function statusBarTextWidth(value: string): number {
  return Array.from(value).reduce(
    (columns, char) => columns + (STATUS_BAR_NARROW_GLYPHS.has(char) ? 1 : terminalTextWidth(char)),
    0,
  );
}

const GROUP_SEPARATOR_TEXT = ` ${GLYPH_SEPARATOR} `;
const METRIC_SEPARATOR_TEXT = ' · ';
const GROUP_SEPARATOR_WIDTH = statusBarTextWidth(GROUP_SEPARATOR_TEXT);
const METRIC_SEPARATOR_WIDTH = statusBarTextWidth(METRIC_SEPARATOR_TEXT);

type SeparatorKind = 'group' | 'metric';

interface RenderedSegment {
  id: string;
  text: string;
  tone?: StatusSegmentView['tone'];
  bold?: boolean;
  showSeparator: boolean;
  separator?: SeparatorKind;
}

function separatorWidth(kind: SeparatorKind | undefined): number {
  if (kind === 'group') return GROUP_SEPARATOR_WIDTH;
  if (kind === 'metric') return METRIC_SEPARATOR_WIDTH;
  return 0;
}

function computeVisible(segments: ReadonlyArray<StatusSegmentView>, dropped: ReadonlySet<string>): RenderedSegment[] {
  const visible: RenderedSegment[] = [];
  let anyBefore = false;
  for (const segment of segments) {
    if (!segment.text || dropped.has(segment.id)) continue;
    visible.push({
      id: segment.id,
      text: segment.text,
      tone: segment.tone,
      bold: segment.bold,
      showSeparator: Boolean(segment.separator) && anyBefore,
      separator: segment.separator,
    });
    anyBefore = true;
  }
  return visible;
}

function measureVisible(visible: RenderedSegment[]): number {
  return visible.reduce(
    (total, segment) =>
      total + (segment.showSeparator ? separatorWidth(segment.separator) : 0) + statusBarTextWidth(segment.text),
    0,
  );
}

/**
 * Fits one segment group to `budget` physical columns by dropping whole
 * segments in ascending `tier` order (lowest tier first) until it fits, then —
 * only as a last resort, and only for `truncatableId` — shrinking that one
 * segment's text with an ellipsis. This is the explicit-budget approach
 * BackgroundTasksPanel already uses: compute a hard column budget and shed
 * content deliberately, rather than let Ink's flexbox reflow text mid-word
 * when nothing fits.
 */
function fitGroup(
  defs: ReadonlyArray<StatusSegmentView>,
  budget: number,
  truncatableId?: string,
): { visible: RenderedSegment[]; width: number } {
  const present = defs.filter((segment) => segment.text);
  const dropped = new Set<string>();
  const dropOrder = present
    .filter((segment) => segment.tier != null)
    .sort((a, b) => a.tier! - b.tier!)
    .map((segment) => segment.id);

  let visible = computeVisible(present, dropped);
  let width = measureVisible(visible);

  for (const id of dropOrder) {
    if (width <= budget) break;
    dropped.add(id);
    visible = computeVisible(present, dropped);
    width = measureVisible(visible);
  }

  if (width > budget && truncatableId) {
    const index = visible.findIndex((segment) => segment.id === truncatableId);
    if (index !== -1) {
      const segment = visible[index];
      const ownWidth =
        (segment.showSeparator ? separatorWidth(segment.separator) : 0) + statusBarTextWidth(segment.text);
      const otherWidth = width - ownWidth;
      const separatorPortion = segment.showSeparator ? separatorWidth(segment.separator) : 0;
      const textAllowance = Math.max(1, budget - otherWidth - separatorPortion);
      const truncated = truncateTerminalText(segment.text, textAllowance);
      visible = visible.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text: truncated } : entry));
      width = measureVisible(visible);
    }
  }

  return { visible, width };
}

const Segments: FC<{ visible: RenderedSegment[] }> = ({ visible }) => {
  const theme = useTheme();
  return (
    <>
      {visible.map((segment) => (
        <React.Fragment key={segment.id}>
          {segment.showSeparator && (segment.separator === 'metric' ? <MetricDivider /> : <Divider />)}
          <Text color={segment.tone ? theme[segment.tone] : undefined} bold={segment.bold} wrap="truncate-end">
            {segment.text}
          </Text>
        </React.Fragment>
      ))}
    </>
  );
};

const Alerts: FC<{ alerts: ReadonlyArray<StatusAlertView> }> = ({ alerts }) => {
  const theme = useTheme();
  return (
    <>
      {alerts.map((alert, index) => (
        <React.Fragment key={alert.id}>
          {index > 0 && <Divider />}
          {alert.parts.map((part, partIndex) => (
            <Text key={partIndex} color={theme[part.tone]} bold={part.bold} wrap="truncate-end">
              {part.text}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </>
  );
};

/**
 * Configuration on the left, this turn's numbers on the right. The alert row is
 * where every non-steady-state message lands, so the bar is a single line
 * whenever nothing is wrong — which is most of the time — and grows only to say
 * something.
 */
export const ClassicStatusBar: FC<StatusView> = ({ columns, config, metrics, alerts, quotaText }) => {
  const theme = useTheme();
  // The bar applies paddingX={1} on both sides, so the budget available to
  // segments is narrower than the terminal itself.
  const budget = Math.max(1, columns - 2);

  // Each group is fit to the *full* row budget on its own (drop order on the
  // segments), and only afterward do the two fitted groups get compared to see
  // whether they still coexist on one line. That keeps the drop decision for
  // each group independent of whatever the other group is doing, per the
  // drop-order contract each priority list documents.
  const configFit = fitGroup(config, budget);
  const metricsFit = fitGroup(metrics, budget);
  const bothVisible = configFit.visible.length > 0 && metricsFit.visible.length > 0;
  const combinedWidth = configFit.width + (bothVisible ? GROUP_SEPARATOR_WIDTH : 0) + metricsFit.width;
  const metricsOnOwnRow = metricsFit.visible.length > 0 && combinedWidth > budget;

  return (
    <Box marginTop={1} flexDirection="column" width="100%" paddingX={1}>
      {/* Configuration (left) and this turn's numbers (right). No flexWrap: a
          miscalculated budget should clip a segment via wrap="truncate-end",
          never reflow it mid-word the way the row-level wrap used to. */}
      <Box width="100%">
        <Segments visible={configFit.visible} />
        {!metricsOnOwnRow && metricsFit.visible.length > 0 && (
          <>
            <Divider />
            <Segments visible={metricsFit.visible} />
          </>
        )}
      </Box>
      {metricsOnOwnRow && (
        <Box width="100%" justifyContent="flex-end">
          <Segments visible={metricsFit.visible} />
        </Box>
      )}

      {/* Alerts (left) and provider quota (right). Absent when neither exists. */}
      {(alerts.length > 0 || quotaText) && (
        <Box width="100%">
          <Box flexGrow={1}>
            <Alerts alerts={alerts} />
          </Box>

          {quotaText && (
            <Box flexShrink={0}>
              <Text color={theme.textSubtle} wrap="truncate-end">
                {quotaText}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
