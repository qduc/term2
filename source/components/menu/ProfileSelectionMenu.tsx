import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ProfileOption } from '../../hooks/use-profile-selection.js';
import { SelectionMarker, MenuFooter } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_BORDER, COLOR_BORDER_ACTIVE, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  items: ProfileOption[];
  activeProfileId: string | null;
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const ProfileSelectionMenu: FC<Props> = ({ items, activeProfileId, selectedIndex, scrollOffset = 0, query }) => {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1} flexDirection="column">
        <Text color={COLOR_TEXT_SUBTLE}>Profiles</Text>
        <Text color={COLOR_TEXT_SUBTLE}>No matching profiles</Text>
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const selectedProfile = items[selectedIndex];

  // Fixed list width (24) minus the SelectionMarker gutter (2) and the
  // column's trailing padding (1), minus the active `● ` prefix where
  // present. List labels are truncated to this budget in JS: an unbreakable
  // (truncate-mode) Text reports its full length as its minimum width,
  // which would defeat the column's shrinking on narrow terminals and spill
  // past the border. The full name stays visible in the detail pane.
  const LIST_WIDTH = 24;
  const MARKER_WIDTH = 2;

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Profiles{query ? ` — ${query}` : ''}</Text>
        {/* flexWrap + minWidth is the narrow-terminal plan: while the detail
            pane has at least half the row it sits beside the list with a
            straight divider; below that it drops to its own full-width line
            instead of squeezing the list gutter or fragmenting the text.
            The list column only shrinks when it alone overflows the row
            (never because of the detail), down to a floor that keeps the
            marker plus a readable stub of the name. */}
        <Box flexDirection="row" flexWrap="wrap" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width={LIST_WIDTH}
            flexShrink={1}
            minWidth={10}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
            borderColor={COLOR_BORDER}
            paddingRight={1}
          >
            {hasScrollUp && <Text color={COLOR_TEXT_SUBTLE}>↑ more</Text>}
            {visibleItems.map((profile, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              const isActive = profile.id === activeProfileId;
              const label = isActive ? `● ${profile.displayName}` : profile.displayName;
              const labelBudget = Math.max(LIST_WIDTH - MARKER_WIDTH - 1, 4);
              const displayLabel =
                label.length > labelBudget ? `${label.slice(0, Math.max(labelBudget - 1, 1))}…` : label;
              return (
                <Box key={profile.id}>
                  <SelectionMarker selected={isSelected} />
                  <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected || isActive} wrap="truncate">
                    {displayLabel}
                  </Text>
                </Box>
              );
            })}
            {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ more</Text>}
          </Box>

          {/* Right column: detail for the highlighted profile */}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth="50%" paddingLeft={2}>
            {selectedProfile && (
              <Box flexDirection="column">
                <Text bold color={COLOR_ACCENT}>
                  {selectedProfile.displayName}
                </Text>
                <Box marginTop={1}>
                  <Text color={COLOR_TEXT}>{selectedProfile.detail}</Text>
                </Box>
                <Box marginTop={1}>
                  <Text color={COLOR_TEXT_SUBTLE}>
                    {selectedProfile.id === activeProfileId
                      ? 'Currently active'
                      : `Run /profile ${selectedProfile.shortId} to switch`}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <MenuFooter
        hints={[
          ['↑↓', 'navigate'],
          ['⏎', 'switch'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
};

export default ProfileSelectionMenu;
