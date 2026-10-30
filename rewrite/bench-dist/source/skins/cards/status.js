import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { contextTone, gaugeBar } from '../shared/gauge.js';
import { useMeasuredWidth } from './measure.js';
import { cells, clip } from './width.js';
/** Cells of a gauge bar in the context pill and in each quota pill. */
const CONTEXT_GAUGE_CELLS = 6;
const QUOTA_GAUGE_CELLS = 4;
/** Columns a pill spends on its own padding, and between neighbouring pills. */
const PILL_PADDING = 2;
const PILL_GAP = 1;
/** A pill's text is never clipped below this, however tight the row. */
const MIN_CLIPPED_TEXT = 6;
/** Roles that would be too faint on the pill surface are lifted one step, so text stays readable. */
const onSurface = (tone) => tone === undefined || tone === 'textSubtle' ? 'textMuted' : tone;
const segmentPiece = (segment, pill, overrides = {}) => ({
    id: segment.id,
    pill,
    text: segment.text.trim().replace(/^·\s*/, ''),
    tone: segment.tone,
    bold: segment.bold,
    tier: segment.tier,
    ...overrides,
});
const findSegment = (list, id) => list.find((segment) => segment.id === id && segment.text);
function configPieces(view) {
    const pieces = [];
    const push = (id, pill, overrides = {}) => {
        const segment = findSegment(view.config, id);
        if (segment)
            pieces.push(segmentPiece(segment, pill, overrides));
    };
    const safety = findSegment(view.config, 'safety');
    if (safety) {
        pieces.push(segmentPiece(safety, 'safety', {
            // The marker is a shape as well as a colour: a diamond for "contained", a triangle for "not".
            text: `${safety.tone === 'danger' ? GLYPH_WARNING : '◆'} ${safety.text.trim()}`,
        }));
    }
    push('ssh-marker', 'ssh');
    push('ssh-detail', 'ssh');
    push('mode', 'mode');
    push('queue', 'queue');
    push('provider-model', 'model');
    push('reasoning', 'model', { glue: ' · ' });
    push('mentor', 'mentor');
    const mentor = pieces.find((piece) => piece.id === 'mentor');
    if (mentor)
        mentor.text = `mentor ${mentor.text}`;
    return pieces;
}
function metricPieces(view) {
    const pieces = [];
    const context = findSegment(view.metrics, 'context');
    if (context) {
        const percent = view.gauges.contextPercent;
        if (percent === undefined) {
            pieces.push(segmentPiece(context, 'context'));
        }
        else {
            const clamped = Math.min(100, Math.max(0, percent));
            pieces.push({
                id: 'context',
                pill: 'context',
                text: `ctx ${gaugeBar(clamped, CONTEXT_GAUGE_CELLS)} ${percent}%`,
                tone: contextTone(percent),
                tier: context.tier,
            });
            // The used/window figure the bar summarises; first to go when the row is tight.
            const detail = context.text.replace(/^ctx\s+/i, '').trim();
            if (detail.includes('/')) {
                pieces.push({ id: 'context-detail', pill: 'context', text: detail, tone: 'textMuted', tier: -1 });
            }
        }
    }
    const tokens = findSegment(view.metrics, 'tokens');
    if (tokens)
        pieces.push(segmentPiece(tokens, 'tokens'));
    const speed = findSegment(view.metrics, 'speed');
    if (speed)
        pieces.push(segmentPiece(speed, 'tokens', { tone: 'textMuted' }));
    const cache = findSegment(view.metrics, 'cache');
    if (cache)
        pieces.push(segmentPiece(cache, 'cache'));
    const cost = findSegment(view.metrics, 'cost');
    if (cost)
        pieces.push(segmentPiece(cost, 'cost'));
    return pieces;
}
function toPills(pieces, dropped) {
    const pills = [];
    for (const piece of pieces) {
        if (dropped.has(piece.id))
            continue;
        const existing = pills.find((pill) => pill.id === piece.pill);
        if (existing)
            existing.pieces.push(piece);
        else
            pills.push({ id: piece.pill, pieces: [piece] });
    }
    return pills;
}
const pillText = (pill) => pill.pieces.reduce((out, piece, index) => (index === 0 ? piece.text : `${out}${piece.glue ?? ' '}${piece.text}`), '');
const rowWidth = (pills, framing) => pills.reduce((total, pill) => total + cells(pillText(pill)) + framing, 0) + Math.max(0, pills.length - 1) * PILL_GAP;
/**
 * Fits a row to `budget` columns: drops pieces lowest tier first, exactly as the classic
 * bar would, and only when that is not enough clips the longest remaining piece.
 */
function fitRow(pieces, budget, framing) {
    const dropped = new Set();
    const order = pieces
        .filter((piece) => piece.tier !== undefined)
        .sort((a, b) => a.tier - b.tier)
        .map((piece) => piece.id);
    let pills = toPills(pieces, dropped);
    for (const id of order) {
        if (rowWidth(pills, framing) <= budget)
            break;
        dropped.add(id);
        pills = toPills(pieces, dropped);
    }
    const working = pieces.filter((piece) => !dropped.has(piece.id)).map((piece) => ({ ...piece }));
    for (let attempt = 0; attempt < 6; attempt += 1) {
        pills = toPills(working, new Set());
        const overflow = rowWidth(pills, framing) - budget;
        if (overflow <= 0)
            break;
        const longest = working.reduce((best, piece) => (cells(piece.text) > cells(best.text) ? piece : best), working[0]);
        if (!longest || cells(longest.text) <= MIN_CLIPPED_TEXT)
            break;
        longest.text = clip(longest.text, Math.max(MIN_CLIPPED_TEXT, cells(longest.text) - overflow));
    }
    return pills;
}
/** One pill: a quiet surface behind the text. With no colours at all, `‹ ›` stand in for the surface. */
const PillView = ({ pill }) => {
    const theme = useTheme();
    const surface = theme.codeBackground;
    const frame = surface === undefined;
    return (React.createElement(Text, { backgroundColor: surface, wrap: "truncate-end" },
        frame ? '‹ ' : ' ',
        pill.pieces.map((piece, index) => (React.createElement(React.Fragment, { key: piece.id },
            index > 0 ? piece.glue ?? ' ' : '',
            React.createElement(Text, { color: theme[onSurface(piece.tone)], bold: piece.bold }, piece.text)))),
        frame ? ' ›' : ' '));
};
const Row = ({ pills }) => (React.createElement(Box, { flexWrap: "wrap", columnGap: PILL_GAP }, pills.map((pill) => (React.createElement(PillView, { key: pill.id, pill: pill })))));
const Alerts = ({ alerts }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexWrap: "wrap", columnGap: 2 }, alerts.map((alert) => (React.createElement(Text, { key: alert.id }, alert.parts.map((part, index) => (React.createElement(Text, { key: index, color: theme[part.tone], bold: part.bold }, part.text))))))));
};
const quotaPill = (window) => ({
    id: `quota-${window.label}`,
    pieces: [
        {
            id: `quota-${window.label}`,
            pill: `quota-${window.label}`,
            text: `${window.label} ${gaugeBar(window.percent, QUOTA_GAUGE_CELLS)} ${window.percent}%${window.resetText ? `→${window.resetText}` : ''}`,
            tone: contextTone(window.percent),
        },
    ],
});
/**
 * A row of pills: safety, who is answering, then this turn's numbers (the context
 * gauge, tokens, cache, cost). Everything that is not steady state, the alerts and the
 * provider quota, sits on a second row that exists only while there is something to say.
 */
export const CardsStatusBar = ({ columns, config, metrics, alerts, quotaText, gauges }) => {
    const framing = useTheme().codeBackground === undefined ? PILL_PADDING + 2 : PILL_PADDING;
    // The row's real width is measured, since `columns` is the terminal's and not always known.
    const [measureRef, measured] = useMeasuredWidth(columns, columns);
    const budget = Math.max(1, measured);
    const segments = { config, metrics, gauges };
    const configPiecesAll = configPieces(segments);
    const metricPiecesAll = metricPieces(segments);
    const configFit = fitRow(configPiecesAll, budget, framing);
    const metricsFit = fitRow(metricPiecesAll, budget, framing);
    const fitsOnOneRow = configFit.length === 0 ||
        metricsFit.length === 0 ||
        rowWidth(configFit, framing) + PILL_GAP + rowWidth(metricsFit, framing) <= budget;
    // Before giving the numbers a row of their own, see whether everything but the
    // garnish (the used/window figure and the live rate) fits on one: a single row is
    // the quieter bar, and those two are the least that is lost.
    const essential = toPills([...configPiecesAll, ...metricPiecesAll].filter((piece) => piece.tier === undefined || piece.tier > 0), new Set());
    const essentialFitsOnOneRow = rowWidth(essential, framing) <= budget;
    const pillRows = fitsOnOneRow
        ? [[...configFit, ...metricsFit]]
        : essentialFitsOnOneRow
            ? [essential]
            : [configFit, metricsFit];
    const quotaPills = gauges.quotaWindows.length > 0 ? gauges.quotaWindows.map(quotaPill) : [];
    const hasSecondRow = alerts.length > 0 || quotaPills.length > 0 || quotaText !== '';
    return (React.createElement(Box, { marginTop: 1, flexDirection: "column", width: "100%", ref: measureRef },
        pillRows.map((pills) => (React.createElement(Row, { key: pills.map((pill) => pill.id).join(), pills: pills }))),
        hasSecondRow && (React.createElement(Box, { flexDirection: "column" },
            alerts.length > 0 && React.createElement(Alerts, { alerts: alerts }),
            quotaPills.length > 0 ? React.createElement(Row, { pills: quotaPills }) : quotaText !== '' && React.createElement(QuotaText, { text: quotaText })))));
};
/** The container's own quota text, for providers whose windows arrive without structure. */
const QuotaText = ({ text }) => {
    const theme = useTheme();
    return React.createElement(Text, { color: theme.textMuted }, text);
};
//# sourceMappingURL=status.js.map