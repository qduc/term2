import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_WARNING, useTheme, type ColorRole } from '../../components/theme.js';
import { truncateTerminalText } from '../../components/layout/terminal-text-budget.js';
import { formatContextUsage } from '../../utils/ai/token-usage.js';
import { CONTEXT_WARN_PERCENT, contextTone, gaugeBar } from '../shared/gauge.js';
import type { StatusAlertView, StatusQuotaWindow, StatusSegmentView, StatusView } from '../types.js';
import { Chip } from './chip.js';

/**
 * The footer is a bar of chips. Every glyph used here is a single cell, so a text's
 * width is its length in code points and a row can be budgeted exactly; the
 * conservative double-width estimate would collapse the bar far too eagerly.
 */
const cells = (text: string): number => Array.from(text).length;

/** A chip piece: a run of text in one tone. Pieces with a `tier` can be dropped, lowest first, to fit. */
interface Piece {
  text: string;
  tone: ColorRole;
  bold?: boolean;
  tier?: number;
  /** The one piece that is clipped with an ellipsis as a last resort, rather than dropped. */
  truncatable?: boolean;
}

interface ChipSpec {
  id: string;
  /** A filled chip is one tone end to end; its pieces are joined into one label. */
  solid?: boolean;
  pieces: Piece[];
}

const CHIP_PADDING = 2;
const CHIP_GAP = 1;

/** Text that sits on a chip surface needs more contrast than `textSubtle` has; promote it. */
const onSurface = (tone: ColorRole | undefined): ColorRole =>
  tone === undefined || tone === 'textSubtle' ? 'textMuted' : tone;

const chipWidth = (chip: ChipSpec): number =>
  chip.pieces.reduce((sum, piece, index) => sum + cells(piece.text) + (index > 0 ? 1 : 0), CHIP_PADDING);

const groupWidth = (chips: readonly ChipSpec[]): number =>
  chips.reduce((sum, chip, index) => sum + chipWidth(chip) + (index > 0 ? CHIP_GAP : 0), 0);

/**
 * Drops pieces in ascending tier order until the group fits `budget` columns, then,
 * only if that is not enough, clips the truncatable piece. A chip left with no pieces
 * disappears. If it still does not fit the row wraps (see `ChipRow`); nothing is lost.
 */
function fitChips(chips: readonly ChipSpec[], budget: number): ChipSpec[] {
  let current = chips.map((chip) => ({ ...chip, pieces: [...chip.pieces] }));
  const prune = () => {
    current = current.filter((chip) => chip.pieces.length > 0);
  };

  while (groupWidth(current) > budget) {
    let victim: { chip: ChipSpec; piece: Piece } | undefined;
    for (const chip of current) {
      for (const piece of chip.pieces) {
        if (piece.tier !== undefined && (victim === undefined || piece.tier < victim.piece.tier!)) {
          victim = { chip, piece };
        }
      }
    }
    if (!victim) break;
    victim.chip.pieces = victim.chip.pieces.filter((piece) => piece !== victim!.piece);
    prune();
  }

  const overflow = groupWidth(current) - budget;
  if (overflow > 0) {
    for (const chip of current) {
      chip.pieces = chip.pieces.map((piece) =>
        piece.truncatable
          ? { ...piece, text: truncateTerminalText(piece.text, Math.max(1, cells(piece.text) - overflow)) }
          : piece,
      );
    }
  }
  return current;
}

const ChipView: FC<{ chip: ChipSpec }> = ({ chip }) => {
  const theme = useTheme();
  if (chip.solid) {
    return (
      <Chip solid tone={chip.pieces[0]!.tone}>
        {chip.pieces.map((piece) => piece.text).join(' ')}
      </Chip>
    );
  }
  return (
    <Chip tone="textMuted">
      {chip.pieces.map((piece, index) => (
        <React.Fragment key={index}>
          {index > 0 ? ' ' : ''}
          <Text color={theme[piece.tone]} bold={piece.bold}>
            {piece.text}
          </Text>
        </React.Fragment>
      ))}
    </Chip>
  );
};

/** Wrapping is the safety net, not the plan: a budget that is off by a cell costs a row, never a broken line. */
const ChipRow: FC<{ chips: readonly ChipSpec[] }> = ({ chips }) => (
  <Box flexWrap="wrap" columnGap={CHIP_GAP}>
    {chips.map((chip) => (
      <Box key={chip.id}>
        <ChipView chip={chip} />
      </Box>
    ))}
  </Box>
);

// --- Building the chips from the container's segments --------------------------------

const segmentMap = (segments: ReadonlyArray<StatusSegmentView>): Map<string, StatusSegmentView> =>
  new Map(segments.filter((segment) => segment.text.trim() !== '').map((segment) => [segment.id, segment]));

const KNOWN_CONFIG = new Set([
  'ssh-marker',
  'ssh-detail',
  'mode',
  'queue',
  'provider-model',
  'reasoning',
  'mentor',
  'safety',
]);
const KNOWN_METRICS = new Set(['tokens', 'speed', 'cache', 'context', 'cost']);

/** A segment the skin does not know is still shown, as its own chip, never dropped. */
const unknownChips = (segments: ReadonlyArray<StatusSegmentView>, known: ReadonlySet<string>): ChipSpec[] =>
  segments
    .filter((segment) => segment.text.trim() !== '' && !known.has(segment.id))
    .map((segment) => ({
      id: segment.id,
      pieces: [{ text: segment.text.trim(), tone: onSurface(segment.tone), bold: segment.bold, tier: segment.tier }],
    }));

function configChips(config: ReadonlyArray<StatusSegmentView>): ChipSpec[] {
  const by = segmentMap(config);
  const chips: ChipSpec[] = [];

  const safety = by.get('safety');
  if (safety) {
    const danger = safety.tone === 'danger';
    chips.push({
      id: 'safety',
      solid: true,
      pieces: [
        {
          text: `${danger ? `${GLYPH_WARNING} ` : ''}${safety.text.trim()}`,
          tone: safety.tone ?? 'success',
          bold: true,
        },
      ],
    });
  }

  const sshMarker = by.get('ssh-marker');
  const sshDetail = by.get('ssh-detail');
  if (sshMarker || sshDetail) {
    chips.push({
      id: 'ssh',
      pieces: [
        ...(sshMarker
          ? [{ text: sshMarker.text.trim(), tone: onSurface(sshMarker.tone), bold: true, tier: sshMarker.tier }]
          : []),
        ...(sshDetail ? [{ text: sshDetail.text.trim(), tone: onSurface(sshDetail.tone), tier: sshDetail.tier }] : []),
      ],
    });
  }

  const mode = by.get('mode');
  if (mode) {
    chips.push({ id: 'mode', pieces: [{ text: mode.text.trim(), tone: onSurface(mode.tone), bold: true }] });
  }

  const queue = by.get('queue');
  if (queue) {
    chips.push({
      id: 'queue',
      pieces: [
        { text: queue.text.trim().replace(/^\[|\]$/g, ''), tone: onSurface(queue.tone), bold: true, tier: queue.tier },
      ],
    });
  }

  const model = by.get('provider-model');
  const reasoning = by.get('reasoning');
  if (model || reasoning) {
    chips.push({
      id: 'model',
      pieces: [
        ...(model ? [{ text: model.text.trim(), tone: onSurface(model.tone), bold: true, truncatable: true }] : []),
        ...(reasoning
          ? [
              {
                text: reasoning.text.trim().replace(/^·\s*/, ''),
                tone: onSurface(reasoning.tone),
                tier: reasoning.tier,
              },
            ]
          : []),
      ],
    });
  }

  const mentor = by.get('mentor');
  if (mentor) {
    chips.push({
      id: 'mentor',
      pieces: [
        { text: 'mentor', tone: 'textMuted', tier: mentor.tier },
        { text: mentor.text.trim(), tone: onSurface(mentor.tone), bold: true, tier: mentor.tier },
      ],
    });
  }

  return [...chips, ...unknownChips(config, KNOWN_CONFIG)];
}

const CONTEXT_BAR_CELLS = 6;

/** A usage tone, kept quiet until it matters; a warning also gains a glyph so it survives `mono`. */
const usageTone = (percent: number | undefined): { tone: ColorRole; warn: boolean } => {
  const tone = contextTone(percent);
  return { tone: onSurface(tone), warn: percent !== undefined && percent >= CONTEXT_WARN_PERCENT };
};

function metricChips(view: StatusView): ChipSpec[] {
  const by = segmentMap(view.metrics);
  const { gauges } = view;
  const chips: ChipSpec[] = [];

  const context = by.get('context');
  if (gauges.contextPercent !== undefined) {
    const { tone, warn } = usageTone(gauges.contextPercent);
    const percent = Math.round(gauges.contextPercent);
    const detail =
      gauges.contextUsedTokens !== undefined
        ? formatContextUsage(gauges.contextUsedTokens, gauges.contextWindowTokens)
        : undefined;
    chips.push({
      id: 'context',
      pieces: [
        { text: 'ctx', tone: 'textMuted', tier: 3 },
        { text: gaugeBar(percent, CONTEXT_BAR_CELLS), tone, tier: 2.5 },
        { text: `${warn ? `${GLYPH_WARNING} ` : ''}${percent}%`, tone, bold: warn, tier: 3.1 },
        ...(detail ? [{ text: detail, tone: 'textMuted' as const, tier: 1.5 }] : []),
      ],
    });
  } else if (context) {
    chips.push({ id: 'context', pieces: [{ text: context.text.trim(), tone: 'textMuted', tier: context.tier }] });
  }

  const cache = by.get('cache');
  if (cache) {
    chips.push({
      id: 'cache',
      pieces: [{ text: cache.text.trim(), tone: onSurface(cache.tone), bold: cache.bold, tier: cache.tier }],
    });
  }

  const tokens = by.get('tokens');
  const speed = by.get('speed');
  if (tokens || speed) {
    chips.push({
      id: 'tokens',
      pieces: [
        ...(tokens
          ? [{ text: tokens.text.trim(), tone: onSurface(tokens.tone), bold: tokens.bold, tier: tokens.tier }]
          : []),
        ...(speed
          ? [{ text: speed.text.trim().replace(/^\(|\)$/g, ''), tone: onSurface(speed.tone), tier: speed.tier }]
          : []),
      ],
    });
  }

  const cost = by.get('cost');
  if (cost) {
    chips.push({ id: 'cost', pieces: [{ text: cost.text.trim(), tone: onSurface(cost.tone), tier: cost.tier }] });
  }

  return [...chips, ...unknownChips(view.metrics, KNOWN_METRICS)];
}

// --- Quota ------------------------------------------------------------------------

interface QuotaLevel {
  cells: number;
  reset: boolean;
  label: boolean;
}

/** Richest first; the row takes the first one that fits on a single line. */
const QUOTA_LEVELS: readonly QuotaLevel[] = [
  { cells: 8, reset: true, label: true },
  { cells: 6, reset: true, label: true },
  { cells: 6, reset: true, label: false },
  { cells: 4, reset: true, label: false },
  { cells: 4, reset: false, label: false },
];

const QUOTA_LABEL = 'quota ';
const QUOTA_SEPARATOR = ' · ';

const quotaPercent = (window: StatusQuotaWindow): number => Math.round(window.percent);

const quotaWindowText = (window: StatusQuotaWindow, level: QuotaLevel): string => {
  const percent = quotaPercent(window);
  const warn = percent >= CONTEXT_WARN_PERCENT;
  return [
    window.label,
    gaugeBar(percent, level.cells),
    `${warn ? `${GLYPH_WARNING} ` : ''}${percent}%`,
    ...(level.reset && window.resetText ? [`→ ${window.resetText}`] : []),
  ].join(' ');
};

const quotaRowWidth = (windows: ReadonlyArray<StatusQuotaWindow>, level: QuotaLevel): number =>
  (level.label ? QUOTA_LABEL.length : 0) +
  windows.reduce(
    (sum, window, index) => sum + cells(quotaWindowText(window, level)) + (index > 0 ? QUOTA_SEPARATOR.length : 0),
    0,
  );

const QuotaWindowView: FC<{ window: StatusQuotaWindow; level: QuotaLevel }> = ({ window, level }) => {
  const theme = useTheme();
  const percent = quotaPercent(window);
  const { tone, warn } = usageTone(percent);
  return (
    <Text>
      <Text color={theme.textMuted} bold>
        {window.label}
      </Text>{' '}
      <Text color={theme[tone]}>{gaugeBar(percent, level.cells)}</Text>{' '}
      <Text color={theme[tone]} bold={warn}>
        {warn ? `${GLYPH_WARNING} ` : ''}
        {percent}%
      </Text>
      {level.reset && window.resetText ? <Text color={theme.textSubtle}> → {window.resetText}</Text> : null}
    </Text>
  );
};

const QuotaRow: FC<{ windows: ReadonlyArray<StatusQuotaWindow>; budget: number }> = ({ windows, budget }) => {
  const theme = useTheme();
  const level = QUOTA_LEVELS.find((candidate) => quotaRowWidth(windows, candidate) <= budget);

  // Nothing fits on one line: stack the windows, one per row, rather than clip any.
  if (!level) {
    const stacked: QuotaLevel = { cells: 6, reset: true, label: false };
    return (
      <Box flexDirection="column">
        {windows.map((window) => (
          <QuotaWindowView key={window.label} window={window} level={stacked} />
        ))}
      </Box>
    );
  }

  return (
    <Text wrap="truncate">
      {level.label ? <Text color={theme.textSubtle}>{QUOTA_LABEL}</Text> : null}
      {windows.map((window, index) => (
        <React.Fragment key={window.label}>
          {index > 0 ? <Text color={theme.textSubtle}>{QUOTA_SEPARATOR}</Text> : null}
          <QuotaWindowView window={window} level={level} />
        </React.Fragment>
      ))}
    </Text>
  );
};

const AlertRow: FC<{ alerts: ReadonlyArray<StatusAlertView> }> = ({ alerts }) => {
  const theme = useTheme();
  return (
    <Text wrap="wrap">
      {alerts.map((alert, index) => (
        <React.Fragment key={alert.id}>
          {index > 0 ? '  ' : ''}
          {alert.parts.map((part, partIndex) => (
            <Text key={partIndex} color={theme[part.tone]} bold={part.bold}>
              {part.text}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </Text>
  );
};

/**
 * A footer made of chips. Configuration on the left, this turn's numbers on the right
 * when both fit on a row, otherwise stacked; then a quota row of mini gauges when the
 * provider reports windows, then alerts on a row of their own. Each group is fitted to
 * the row by dropping its lowest-tier pieces first, the same order the container ranks them.
 */
export const LedgerStatusBar: FC<StatusView> = (view) => {
  const theme = useTheme();
  const budget = Math.max(1, view.columns - 2);

  const config = fitChips(configChips(view.config), budget);
  const metrics = fitChips(metricChips(view), budget);
  const sideBySide = groupWidth(config) + CHIP_GAP + groupWidth(metrics) <= budget;
  const { quotaWindows } = view.gauges;

  return (
    <Box marginTop={1} flexDirection="column" width="100%" paddingX={1}>
      {sideBySide ? (
        <Box width="100%">
          <ChipRow chips={config} />
          <Box flexGrow={1} />
          <ChipRow chips={metrics} />
        </Box>
      ) : (
        <>
          {config.length > 0 && <ChipRow chips={config} />}
          {metrics.length > 0 && <ChipRow chips={metrics} />}
        </>
      )}

      {quotaWindows.length > 0 ? (
        <QuotaRow windows={quotaWindows} budget={budget} />
      ) : view.quotaText ? (
        <Text color={theme.textSubtle} wrap="wrap">
          {view.quotaText}
        </Text>
      ) : null}

      {view.alerts.length > 0 && <AlertRow alerts={view.alerts} />}
    </Box>
  );
};
