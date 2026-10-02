import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ConversationListEntry } from '../../services/conversation/conversation-persistence.js';
import type { SavedAppMode } from '../../services/conversation/conversation-persistence-types.js';
import { profileIdFromLegacyMode } from '../../services/profiles/legacy-adapter.js';
import { getProfileLabel } from '../../services/profiles/labels.js';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  items: ConversationListEntry[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
  loading?: boolean;
  error?: string | false;
};

function formatDate(dateString: string): string {
  try {
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => n.toString().padStart(2, '0');
      const year = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const date = pad(d.getDate());
      const hours = pad(d.getHours());
      const minutes = pad(d.getMinutes());
      const seconds = pad(d.getSeconds());
      return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
    }
  } catch {
    // fallback
  }
  return dateString;
}

function formatRelativeTime(dateString: string): string {
  const timestamp = Date.parse(dateString);
  if (!Number.isFinite(timestamp)) return dateString;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(0, 'second');
}

function getActiveMode(activeProfileId?: string, appMode?: SavedAppMode): string {
  return getProfileLabel(activeProfileId ?? profileIdFromLegacyMode(appMode));
}

const ResumeSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query, loading, error }) => {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  if (loading || error || items.length === 0) {
    return (
      <MenuFrame
        title="Resume Conversation"
        borderColor={theme.borderActive}
        hasItems={false}
        footer={<MenuFooter hints={[['Esc', 'cancel']]} />}
        footerPlacement="outside"
      >
        <Text color={error ? theme.danger : theme.textSubtle}>
          {loading
            ? 'Loading conversations...'
            : error
            ? `Could not load conversations: ${error}`
            : query
            ? 'No matching conversations'
            : 'No saved conversations found'}
        </Text>
      </MenuFrame>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const selectedEntry = items[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <MenuFrame
        title="Resume Conversation"
        borderColor={theme.borderActive}
        hasItems={true}
        footer={
          <MenuFooter
            hints={[
              ['↑↓', 'navigate'],
              ['⏎', 'resume'],
              ['Esc', 'cancel'],
            ]}
          />
        }
        footerPlacement="outside"
      >
        {/* The two columns split the row evenly at every terminal width: each
            takes half, so the divider sits in the middle instead of tracking
            the longest id. Both columns have a definite width, which lets
            Yoga hand each `wrap="truncate"` label a finite budget — the label
            is clipped to its own column and never spills past the divider or
            the border. The full id stays visible in the detail pane. */}
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
                {visibleItems.map((entry, visibleIndex) => {
                  const actualIndex = scrollOffset + visibleIndex;
                  const isSelected = actualIndex === selectedIndex;
                  return (
                    <Box key={entry.id}>
                      <SelectionMarker selected={isSelected} />
                      <Text color={isSelected ? theme.accent : undefined} bold={isSelected} wrap="truncate">
                        {entry.firstUserMessage?.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled conversation'}
                        {' · '}
                        {formatRelativeTime(entry.updatedAt)}
                        {entry.messageCount !== undefined
                          ? ` · ${entry.messageCount} msg${entry.messageCount === 1 ? '' : 's'}`
                          : ''}
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

          {/* Right column: detail for the highlighted conversation */}
          <Box flexDirection="column" width="50%" paddingLeft={2}>
            {selectedEntry && (
              <Box flexDirection="column">
                <Text bold color={theme.accent}>
                  {selectedEntry.id}
                </Text>
                <Box marginTop={0}>
                  <Text color={theme.textSubtle}>
                    Updated: <Text color={theme.text}>{formatDate(selectedEntry.updatedAt)}</Text>
                  </Text>
                </Box>
                <Box marginTop={0}>
                  <Text color={theme.textSubtle}>
                    {selectedEntry.sshHost ? `SSH (${selectedEntry.sshHost})` : 'Local'}
                    {selectedEntry.messageCount !== undefined &&
                      ` • ${selectedEntry.messageCount} msg${selectedEntry.messageCount === 1 ? '' : 's'}`}
                    {selectedEntry.model && ` • ${selectedEntry.model}`}
                    {getActiveMode(selectedEntry.activeProfileId, selectedEntry.appMode) !== 'standard' &&
                      ` • mode: ${getActiveMode(selectedEntry.activeProfileId, selectedEntry.appMode)}`}
                  </Text>
                </Box>
                {selectedEntry.firstUserMessage && (
                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.textSubtle}>Initial Prompt:</Text>
                    <Text color={theme.text} italic wrap="truncate">
                      "{selectedEntry.firstUserMessage.slice(0, 150).replace(/\n/g, ' ')}"
                    </Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Box>
      </MenuFrame>
    </Box>
  );
};

export default ResumeSelectionMenu;
