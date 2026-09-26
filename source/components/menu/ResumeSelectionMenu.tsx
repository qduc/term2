import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ConversationListEntry } from '../../services/conversation/conversation-persistence.js';
import type { SavedAppMode } from '../../services/conversation/conversation-persistence-types.js';
import { profileIdFromLegacyMode } from '../../services/profiles/legacy-adapter.js';
import { getProfileLabel } from '../../services/profiles/labels.js';
import { MenuFooter, MenuScrollbar, SelectionMarker } from '../common/MenuContainer.js';
import {
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_BORDER_ACTIVE,
  COLOR_DANGER,
  COLOR_TEXT,
  COLOR_TEXT_SUBTLE,
} from '../theme.js';

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
  if (loading || error || items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1} flexDirection="column">
        <Text color={COLOR_TEXT_SUBTLE}>Resume Conversation</Text>
        <Text color={error ? COLOR_DANGER : COLOR_TEXT_SUBTLE}>
          {loading
            ? 'Loading conversations...'
            : error
            ? `Could not load conversations: ${error}`
            : query
            ? 'No matching conversations'
            : 'No saved conversations found'}
        </Text>
        <MenuFooter hints={[['Esc', 'cancel']]} />
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const selectedEntry = items[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Resume Conversation</Text>
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
            borderColor={COLOR_BORDER}
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
                      <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected} wrap="truncate">
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
                <Text bold color={COLOR_ACCENT}>
                  {selectedEntry.id}
                </Text>
                <Box marginTop={0}>
                  <Text color={COLOR_TEXT_SUBTLE}>
                    Updated: <Text color={COLOR_TEXT}>{formatDate(selectedEntry.updatedAt)}</Text>
                  </Text>
                </Box>
                <Box marginTop={0}>
                  <Text color={COLOR_TEXT_SUBTLE}>
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
                    <Text color={COLOR_TEXT_SUBTLE}>Initial Prompt:</Text>
                    <Text color={COLOR_TEXT} italic wrap="truncate">
                      "{selectedEntry.firstUserMessage.slice(0, 150).replace(/\n/g, ' ')}"
                    </Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <MenuFooter
        hints={[
          ['↑↓', 'navigate'],
          ['⏎', 'resume'],
          ['Esc', 'cancel'],
        ]}
      />
    </Box>
  );
};

export default ResumeSelectionMenu;
