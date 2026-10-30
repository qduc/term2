import { useTheme } from '../../components/theme.js';
export function useZenStyles() {
    const theme = useTheme();
    // A palette without colour (mono) answers `undefined` for every role.
    const colourless = theme.textSubtle === undefined;
    return {
        quiet: { color: theme.textMuted, dimColor: colourless },
        faint: { color: theme.textSubtle, dimColor: colourless },
        colourless,
    };
}
/** Columns the zen layers share: the marker column ("◆ ", "✓ ", "▲ ") and the indent under it. */
export const MARKER_COLUMNS = 2;
//# sourceMappingURL=style.js.map