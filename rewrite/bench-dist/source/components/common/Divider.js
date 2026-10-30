import React from 'react';
import { Box } from 'ink';
import { useTheme } from '../theme.js';
/**
 * A horizontal rule drawn as a top-only border, so Yoga sizes it to the
 * container (and re-sizes it on resize while it is still in the live region)
 * instead of a hard-coded character count that wraps or falls short.
 */
const Divider = ({ width }) => {
    const theme = useTheme();
    return (React.createElement(Box, { width: width ?? '100%', borderStyle: "single", borderColor: theme.border, borderTop: true, borderBottom: false, borderLeft: false, borderRight: false }));
};
export default Divider;
//# sourceMappingURL=Divider.js.map