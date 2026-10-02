import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ProfileOption } from '../../hooks/use-profile-selection.js';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  items: ProfileOption[];
  activeProfileId: string | null;
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

const ProfileSelectionMenu: FC<Props> = ({ items, activeProfileId, selectedIndex, scrollOffset = 0, query }) => {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <MenuFrame
          title="Profiles"
          borderColor={theme.borderActive}
          hasItems={false}
          footer={<MenuFooter hints={[['Esc', 'cancel']]} />}
          footerPlacement="outside"
        >
          <Text color={theme.textSubtle}>No matching profiles</Text>
        </MenuFrame>
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const selectedProfile = items[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <MenuFrame
        title={`Profiles${query ? ` — ${query}` : ''}`}
        borderColor={theme.borderActive}
        hasItems={true}
        footer={
          <MenuFooter
            hints={[
              ['↑↓', 'navigate'],
              ['⏎', 'switch'],
              ['Esc', 'cancel'],
            ]}
          />
        }
        footerPlacement="outside"
      >
        {/* The two columns split the row evenly at every terminal width: each
            takes half, so the divider sits in the middle instead of at a fixed
            offset. Both columns have a definite width, which lets Yoga hand
            each `wrap="truncate"` label a finite budget — the label is clipped
            to its own column and never spills past the divider or the border.
            The full name stays visible in the detail pane. */}
        <Box flexDirection="row" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width="50%"
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
            borderColor={theme.border}
            paddingRight={1}
          >
            <Box flexDirection="row" width="100%">
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                {visibleItems.map((profile, visibleIndex) => {
                  const actualIndex = scrollOffset + visibleIndex;
                  const isSelected = actualIndex === selectedIndex;
                  const isActive = profile.id === activeProfileId;
                  const label = isActive ? `● ${profile.displayName}` : profile.displayName;
                  return (
                    <Box key={profile.id}>
                      <SelectionMarker selected={isSelected} />
                      <Text color={isSelected ? theme.accent : undefined} bold={isSelected || isActive} wrap="truncate">
                        {label}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
              {hasScrollUp || hasScrollDown ? (
                <MenuScrollbar itemCount={items.length} scrollOffset={scrollOffset} maxHeight={maxHeight} />
              ) : null}
            </Box>
          </Box>

          {/* Right column: detail for the highlighted profile */}
          <Box flexDirection="column" width="50%" paddingLeft={2}>
            {selectedProfile && (
              <Box flexDirection="column">
                <Text bold color={theme.accent}>
                  {selectedProfile.displayName}
                </Text>
                <Box marginTop={1}>
                  <Text color={theme.text}>{selectedProfile.detail}</Text>
                </Box>
                <Box marginTop={1}>
                  <Text color={theme.textSubtle}>
                    {selectedProfile.id === activeProfileId
                      ? 'Currently active'
                      : `Run /profile ${selectedProfile.shortId} to switch`}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      </MenuFrame>
    </Box>
  );
};

export default ProfileSelectionMenu;
