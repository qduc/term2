import React, { FC } from 'react';
import { Box } from 'ink';
import { COLOR_BORDER } from '../theme.js';

/**
 * A horizontal rule drawn as a top-only border, so Yoga sizes it to the
 * container (and re-sizes it on resize while it is still in the live region)
 * instead of a hard-coded character count that wraps or falls short.
 */
const Divider: FC<{ width?: number }> = ({ width }) => (
  <Box
    width={width ?? '100%'}
    borderStyle="single"
    borderColor={COLOR_BORDER}
    borderTop
    borderBottom={false}
    borderLeft={false}
    borderRight={false}
  />
);

export default Divider;
