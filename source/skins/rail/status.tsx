import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_WARNING, useTheme } from '../../components/theme.js';
import type { ColorRole } from '../../theme/palettes.js';
import { CONTEXT_DANGER_PERCENT, CONTEXT_WARN_PERCENT, contextTone, gaugeBar } from '../shared/gauge.js';
import type { StatusAlertView, StatusQuotaWindow, StatusSegmentView, StatusView } from '../types.js';
import { cells } from './parts.js';

const GAUGE_CELLS = 5;
const SEPARATOR = ' · ';
const SEPARATOR_WIDTH = cells(SEPARATOR);

/** A run of text with one style, so an item can mix a quiet label with a loud value. */
interface Part {
  text: string;
  tone?: ColorRole;
  bold?: boolean;
}

/** One thing on the status line. Items are joined by ` · ` unless glued to the one before. */
interface Item {
  id: string;
  parts: Part[];
  /** Drop order when space runs out: lower goes first; undefined is never dropped. */
  tier?: number;
  /** Attach with a single space instead of a separator (an effort beside its model). */
  glue?: boolean;
}

const widthOf = (item: Item): number => item.parts.reduce((total, part) => total + cells(part.text), 0);

function segment(view: StatusSegmentView, overrides: Partial<Item> = {}): Item | undefined {
  if (!view.text) return undefined;
  return {
    id: view.id,
    parts: [{ text: view.text.trim(), tone: view.tone, bold: view.bold }],
    tier: view.tier,
    ...overrides,
  };
}

/**
 * `ctx ▰▰▰▱▱ 84%`, quiet until it matters. At 75% the number turns bold and warm;
 * at 90% a `▲` is added, so a nearly-full context is noticed in `mono` too. A
 * context that is filling up is never dropped for space.
 */
function contextItem(percent: number | undefined, fallback: StatusSegmentView | undefined): Item | undefined {
  if (percent === undefined) return fallback && segment(fallback);
  const tone = contextTone(percent);
  const hot = percent >= CONTEXT_WARN_PERCENT;
  const danger = percent >= CONTEXT_DANGER_PERCENT;
  return {
    id: 'context',
    tier: hot ? undefined : fallback?.tier,
    parts: [
      { text: 'ctx ', tone: 'textSubtle' },
      { text: `${gaugeBar(percent, GAUGE_CELLS)} ${percent}%${danger ? ` ${GLYPH_WARNING}` : ''}`, tone, bold: hot },
    ],
  };
}

/** `gpt-5.6-luna high`: the effort is a quiet suffix of the model, not its own segment. */
const stripLeadingDot = (text: string): string => text.replace(/^[\s·]+/, '');

/** The segments this skin shows, in its own order: where, how safe, which model, then the numbers. */
function buildItems({ config, metrics, gauges }: StatusView): Item[] {
  const byId = (list: ReadonlyArray<StatusSegmentView>, id: string) => list.find((view) => view.id === id);
  const items: Array<Item | undefined> = [];

  const sshMarker = byId(config, 'ssh-marker');
  const sshDetail = byId(config, 'ssh-detail');
  items.push(sshMarker && segment(sshMarker));
  items.push(sshDetail && segment(sshDetail, { glue: true }));

  const safety = byId(config, 'safety');
  const mode = byId(config, 'mode');
  const queue = byId(config, 'queue');
  const model = byId(config, 'provider-model');
  const reasoning = byId(config, 'reasoning');
  const mentor = byId(config, 'mentor');
  items.push(safety && segment(safety));
  items.push(mode && segment(mode));
  items.push(queue && segment(queue));
  items.push(model && segment(model));
  items.push(
    reasoning && segment({ ...reasoning, text: stripLeadingDot(reasoning.text), tone: 'textSubtle' }, { glue: true }),
  );
  items.push(mentor && segment(mentor));

  items.push(contextItem(gauges.contextPercent, byId(metrics, 'context')));
  const cost = byId(metrics, 'cost');
  const cache = byId(metrics, 'cache');
  const speed = byId(metrics, 'speed');
  items.push(cost && segment(cost));
  items.push(cache && segment(cache));
  items.push(speed && segment({ ...speed, text: speed.text.replace(/^\((.*)\)$/, '$1') }));

  return items.filter((item): item is Item => item !== undefined);
}

const separatorBefore = (items: Item[], index: number): number =>
  index === 0 ? 0 : items[index].glue ? 1 : SEPARATOR_WIDTH;

const totalWidth = (items: Item[]): number =>
  items.reduce((total, item, index) => total + separatorBefore(items, index) + widthOf(item), 0);

/** Drops the lowest-tier items one at a time until the line fits, or only never-dropped ones remain. */
function fitItems(items: Item[], budget: number): Item[] {
  let kept = items;
  while (totalWidth(kept) > budget) {
    const droppable = kept.filter((item) => item.tier !== undefined);
    if (droppable.length === 0) break;
    // Lowest tier first; among equals the one furthest right, which is the least important by position.
    const lowest = Math.min(...droppable.map((item) => item.tier!));
    const victim = [...droppable].reverse().find((item) => item.tier === lowest)!;
    kept = kept.filter((item) => item !== victim);
    // A glued item belongs to the item before it: if that was the victim, the glue has nothing to attach to.
    if (kept[0]?.glue) kept = [{ ...kept[0], glue: false }, ...kept.slice(1)];
  }
  return kept;
}

const ItemText: FC<{ item: Item }> = ({ item }) => {
  const theme = useTheme();
  return (
    <>
      {item.parts.map((part, index) => (
        <Text key={index} color={part.tone ? theme[part.tone] : undefined} bold={part.bold}>
          {part.text}
        </Text>
      ))}
    </>
  );
};

/** `5H ▰▰▱▱▱ 42%→3h`: a window of provider quota as a mini gauge. */
const QuotaGauge: FC<{ window: StatusQuotaWindow }> = ({ window }) => {
  const theme = useTheme();
  const tone = theme[contextTone(window.percent)];
  return (
    <Text>
      <Text color={theme.textSubtle}>{window.label} </Text>
      <Text color={tone}>
        {gaugeBar(window.percent, GAUGE_CELLS)} {window.percent}%
      </Text>
      {window.resetText ? <Text color={theme.textSubtle}>→{window.resetText}</Text> : null}
    </Text>
  );
};

const Alert: FC<{ alert: StatusAlertView }> = ({ alert }) => {
  const theme = useTheme();
  return (
    <Text>
      {alert.parts.map((part, index) => (
        <Text key={index} color={theme[part.tone]} bold={part.bold}>
          {part.text}
        </Text>
      ))}
    </Text>
  );
};

/**
 * One line when nothing is wrong: `Sandboxed · codex/gpt-5.6-luna high · ctx ▰▰▰▱▱ 84% · $0.12`.
 * A second line appears only for an alert or provider quota. Low-priority
 * segments drop by their `tier` as the terminal narrows; whatever must stay and
 * still does not fit wraps onto another line rather than being cut.
 */
export const RailStatusBar: FC<StatusView> = (view) => {
  const theme = useTheme();
  const { columns, alerts, quotaText, gauges } = view;
  const kept = fitItems(buildItems(view), Math.max(1, columns));
  const hasQuota = gauges.quotaWindows.length > 0 || quotaText !== '';

  // Units, not items, are what wraps: an effort stays beside its model. The
  // separator trails its unit, so a wrapped line never begins with a dot.
  const units: Item[][] = [];
  for (const item of kept) {
    if (item.glue && units.length > 0) units[units.length - 1].push(item);
    else units.push([item]);
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box flexWrap="wrap" columnGap={1}>
        {units.map((unit, unitIndex) => (
          <Text key={unit[0].id}>
            {unit.map((item, itemIndex) => (
              <React.Fragment key={item.id}>
                {itemIndex > 0 && ' '}
                <ItemText item={item} />
              </React.Fragment>
            ))}
            {unitIndex < units.length - 1 && <Text color={theme.textSubtle}> ·</Text>}
          </Text>
        ))}
      </Box>
      {(alerts.length > 0 || hasQuota) && (
        <Box flexWrap="wrap" columnGap={2}>
          {alerts.map((alert) => (
            <Alert key={alert.id} alert={alert} />
          ))}
          {gauges.quotaWindows.length > 0
            ? gauges.quotaWindows.map((window) => <QuotaGauge key={window.label} window={window} />)
            : quotaText && <Text color={theme.textSubtle}>{quotaText}</Text>}
        </Box>
      )}
    </Box>
  );
};
