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

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Profiles{query ? ` — ${query}` : ''}</Text>
        <Box flexDirection="row" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width={24}
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
              return (
                <Box key={profile.id}>
                  <SelectionMarker selected={isSelected} />
                  <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected || isActive} wrap="truncate">
                    {isActive ? `● ${profile.displayName}` : profile.displayName}
                  </Text>
                </Box>
              );
            })}
            {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ more</Text>}
          </Box>

          {/* Right column: detail for the highlighted profile */}
          <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
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
