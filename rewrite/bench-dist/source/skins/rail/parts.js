import React from 'react';
import { Box } from 'ink';
import { useTheme } from '../../components/theme.js';
/** A border style that draws only its left edge, as one repeated glyph: the rail. */
const railStyle = (glyph) => ({
    topLeft: '',
    top: '',
    topRight: '',
    right: '',
    bottomRight: '',
    bottom: '',
    bottomLeft: '',
    left: glyph,
});
/** Thin, for a calm tool call. */
export const RAIL_THIN = '▎';
/** Heavier, for a call that failed or an approval that needs a decision. */
export const RAIL_HEAVY = '▌';
/** The heaviest, reserved for the riskiest approval class. */
export const RAIL_SOLID = '█';
/**
 * A rail down the left of its children, one glyph per line, sized by Yoga so it
 * follows wrapped lines and resizes with the terminal. It costs two columns: the
 * glyph and one column of padding, which every caller accounts for.
 */
export const Rail = ({ glyph, color, children, }) => (React.createElement(Box, { flexDirection: "column", borderStyle: railStyle(glyph), borderColor: color, borderTop: false, borderBottom: false, borderRight: false, paddingLeft: 1 }, children));
/**
 * A one-cell-tall horizontal rule. In `mono` there is no colour to make it recede,
 * so it is dimmed instead of drawn at full weight.
 */
export const Hairline = () => {
    const theme = useTheme();
    return (React.createElement(Box, { width: "100%", borderStyle: "single", borderColor: theme.border, borderDimColor: theme.border === undefined, borderTop: true, borderBottom: false, borderLeft: false, borderRight: false }));
};
/** Columns a string occupies, for the single-cell glyphs this skin is built from. */
export const cells = (value) => Array.from(value).length;
//# sourceMappingURL=parts.js.map