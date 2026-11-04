import React, { useMemo } from 'react';
import { Box } from 'ink';
import SessionBoundary from './presentation/components/message/SessionBoundary.js';

/** Rows SessionBoundary adds above the banner. */
export const BOUNDARY_ROWS = 4;

/** Legacy starts a new conversation under a SessionBoundary rule, printed above the banner. */
export function useNewConversationHeader(
  header: React.ReactNode,
  newConversation: readonly string[] | undefined,
  columns: number,
): React.ReactNode {
  return useMemo(
    () =>
      newConversation ? (
        <Box flexDirection="column">
          <Box paddingX={2}>
            <SessionBoundary width={Math.max(1, columns - 4)} />
          </Box>
          {header}
        </Box>
      ) : (
        header
      ),
    // The banner is printed once; a later resize must not re-key the static rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newConversation, header],
  );
}
