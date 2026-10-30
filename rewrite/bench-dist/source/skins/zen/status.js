import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { CONTEXT_DANGER_PERCENT, CONTEXT_WARN_PERCENT, contextTone } from '../shared/gauge.js';
import { useZenStyles } from './style.js';
import { cells } from './width.js';
/** A quota window is only worth a word once it is nearly spent. */
const QUOTA_SHOWN_ABOVE_PERCENT = 75;
const QUOTA_URGENT_PERCENT = 90;
const SEPARATOR = ' · ';
const toneLook = (tone, bold) => tone === undefined || tone === 'textSubtle' ? { kind: 'faint' } : { kind: 'tone', tone, bold };
/**
 * The line zen says everything on. The safety label leads because it answers the
 * question people actually glance down here for; the model follows, then whatever
 * is worth a word. Only what the container flagged as attention keeps its tone.
 */
function configFragments(config) {
    const byId = new Map(config.filter((segment) => segment.text).map((segment) => [segment.id, segment]));
    const order = ['ssh-marker', 'ssh-detail', 'safety', 'mode', 'queue', 'provider-model', 'reasoning', 'mentor'];
    const fragments = [];
    for (const id of order) {
        const segment = byId.get(id);
        if (!segment)
            continue;
        // `reasoning` arrives as " · high", already carrying its own separator; ssh-detail follows its marker.
        const attached = id === 'reasoning' || id === 'ssh-detail';
        const look = id === 'safety'
            ? toneLook(segment.tone, segment.tone === 'danger')
            : id === 'provider-model'
                ? { kind: 'quiet' }
                : id === 'reasoning'
                    ? { kind: 'faint' }
                    : toneLook(segment.tone, segment.bold);
        fragments.push({
            id,
            text: attached ? segment.text : segment.text.trim(),
            look,
            separated: !attached,
            tier: segment.tier,
            group: 'config',
        });
    }
    return fragments;
}
const contextText = (percent, level) => {
    const base = `${percent}% ctx`;
    if (level === 'short')
        return percent >= CONTEXT_DANGER_PERCENT ? `${GLYPH_WARNING} ${base}` : base;
    if (percent >= CONTEXT_DANGER_PERCENT)
        return `${GLYPH_WARNING} ${base} — run /compact`;
    if (percent >= CONTEXT_WARN_PERCENT)
        return `${base} — consider /compact`;
    return base;
};
const quotaFragments = (windows) => windows
    .filter((window) => window.percent > QUOTA_SHOWN_ABOVE_PERCENT)
    .map((window) => ({
    id: `quota-${window.label}`,
    text: `${window.label} ${window.percent}%${window.resetText ? `→${window.resetText}` : ''}`,
    look: window.percent >= QUOTA_URGENT_PERCENT
        ? { kind: 'tone', tone: 'warning', bold: true }
        : { kind: 'faint' },
    separated: true,
    // Nearly out of quota is the kind of thing this line exists to say.
    tier: window.percent >= QUOTA_URGENT_PERCENT ? undefined : 2,
    group: 'metrics',
}));
function metricFragments(view, contextLevel) {
    const { metrics, gauges } = view;
    const fragments = [];
    for (const segment of metrics) {
        if (!segment.text)
            continue;
        if (segment.id === 'context') {
            const percent = gauges.contextPercent;
            fragments.push({
                id: 'context',
                text: percent === undefined ? segment.text : contextText(percent, contextLevel),
                look: percent === undefined ? { kind: 'faint' } : toneLook(contextTone(percent), percent >= CONTEXT_DANGER_PERCENT),
                separated: true,
                // A window that is filling up is what the line exists to say; below that it is furniture.
                tier: percent !== undefined && percent >= CONTEXT_WARN_PERCENT ? undefined : segment.tier,
                group: 'metrics',
            });
            continue;
        }
        // Numbers that are merely informative (tokens, speed, cache hit rate) are not zen's business. A
        // metric the container has toned, or refused to let go of (a cache-miss warning), is attention.
        const needsAttention = segment.tier === undefined || (segment.tone !== undefined && segment.tone !== 'textSubtle');
        if (segment.id === 'cost' || needsAttention) {
            fragments.push({
                id: segment.id,
                text: segment.text,
                look: toneLook(segment.tone, segment.bold),
                separated: true,
                tier: segment.tier,
                group: 'metrics',
            });
        }
    }
    return fragments;
}
const widthOf = (fragments) => fragments.reduce((total, fragment, index) => {
    const separator = index > 0 && fragment.separated ? cells(SEPARATOR) : 0;
    return total + separator + cells(fragment.text);
}, 0);
/** Sheds whole fragments, lowest tier first, until the line fits; fragments with no tier are never shed. */
function fit(fragments, budget) {
    const remaining = [...fragments];
    while (widthOf(remaining) > budget) {
        let victim = -1;
        remaining.forEach((fragment, index) => {
            if (fragment.tier === undefined)
                return;
            if (victim === -1 || fragment.tier < remaining[victim].tier)
                victim = index;
        });
        if (victim === -1)
            break;
        remaining.splice(victim, 1);
    }
    return remaining;
}
const Alert = ({ alert }) => {
    const theme = useTheme();
    const { colourless } = useZenStyles();
    const text = alert.parts.map((part) => part.text).join('');
    const lead = text.trimStart().startsWith(GLYPH_WARNING) ? null : (React.createElement(Text, { color: alert.parts.some((part) => part.tone === 'danger') ? theme.danger : theme.warning, bold: true },
        GLYPH_WARNING,
        ' '));
    return (React.createElement(Box, { justifyContent: "flex-end" },
        React.createElement(Text, { wrap: "wrap" },
            lead,
            alert.parts.map((part, index) => (React.createElement(Text, { key: index, color: theme[part.tone], bold: part.bold || (colourless && part.tone !== 'textSubtle') }, part.text))))));
};
/**
 * Nearly invisible. One right-aligned, dim line, `Sandboxed · Codex/gpt-5.6-luna · 84% ctx`,
 * that is allowed to raise its voice in exactly two ways: the context segment warns
 * at 75% and escalates at 90%, and alerts (the reasons the bar speaks up at all)
 * each get their own line in their own tone, above it. Quota appears only when a
 * window is nearly spent.
 */
export const ZenStatusBar = (view) => {
    const theme = useTheme();
    const { quiet, faint, colourless } = useZenStyles();
    const budget = Math.max(1, view.columns - 2);
    // A tone with no colour to carry it has to carry itself in weight.
    const styleOf = (look) => look.kind === 'quiet'
        ? quiet
        : look.kind === 'faint'
            ? faint
            : { color: theme[look.tone], bold: look.bold || colourless, dimColor: false };
    const assemble = (contextLevel) => [
        ...configFragments(view.config),
        ...metricFragments(view, contextLevel),
        ...quotaFragments(view.gauges.quotaWindows),
    ];
    // The advice is the first thing to go; the percentage and its tone carry the warning on their own.
    const full = assemble('full');
    const fragments = fit(widthOf(full) <= budget ? full : assemble('short'), budget);
    // Only when what must stay still does not fit on one line (a narrow terminal with the window filling
    // up) does the line break, and then between its two halves rather than in the middle of one.
    const rows = widthOf(fragments) <= budget
        ? [fragments]
        : [fragments.filter((f) => f.group === 'config'), fragments.filter((f) => f.group === 'metrics')];
    if (fragments.length === 0 && view.alerts.length === 0)
        return null;
    return (React.createElement(Box, { marginTop: 1, flexDirection: "column", width: "100%", paddingX: 1 },
        view.alerts.map((alert) => (React.createElement(Alert, { key: alert.id, alert: alert }))),
        rows
            .filter((row) => row.length > 0)
            .map((row) => (React.createElement(Box, { key: row[0].id, justifyContent: "flex-end" },
            React.createElement(Text, { wrap: "wrap" }, row.map((fragment, index) => (React.createElement(React.Fragment, { key: fragment.id },
                index > 0 && fragment.separated && React.createElement(Text, { ...faint }, SEPARATOR),
                React.createElement(Text, { ...styleOf(fragment.look) }, fragment.text))))))))));
};
//# sourceMappingURL=status.js.map