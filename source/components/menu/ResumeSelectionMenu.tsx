import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ConversationListEntry } from '../../services/conversation/conversation-persistence.js';
import type { SavedAppMode } from '../../services/conversation/conversation-persistence-types.js';
import { SelectionMarker, MenuFooter } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_BORDER, COLOR_BORDER_ACTIVE, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  items: ConversationListEntry[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
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

function getActiveMode(appMode?: SavedAppMode): string {
  if (!appMode) return 'standard';
  if (appMode.orchestratorMode) return 'orchestrator';
  if (appMode.liteMode) return 'lite';
  if (appMode.planMode) return 'plan';
  if (appMode.mentorMode) return 'mentor';
  return 'standard';
}

const ResumeSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query }) => {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} paddingX={1} flexDirection="column">
        <Text color={COLOR_TEXT_SUBTLE}>Resume Conversation</Text>
        <Text color={COLOR_TEXT_SUBTLE}>{query ? 'No matching conversations' : 'No saved conversations found'}</Text>
      </Box>
    );
  }

  const maxHeight = 10;
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  const longestIdLength = Math.max(...items.map((item) => item.id.length), 10);
  const leftColWidth = Math.min(longestIdLength + 4, 32);

  const selectedEntry = items[selectedIndex];

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={COLOR_BORDER_ACTIVE} flexDirection="column" width="100%" paddingX={1}>
        <Text color={COLOR_TEXT_SUBTLE}>Resume Conversation</Text>
        <Box flexDirection="row" width="100%">
          {/* Left column: the list */}
          <Box
            flexDirection="column"
            width={leftColWidth}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
            borderColor={COLOR_BORDER}
            paddingRight={1}
          >
            {hasScrollUp && <Text color={COLOR_TEXT_SUBTLE}>↑ more</Text>}
            {visibleItems.map((entry, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              return (
                <Box key={entry.id}>
                  <SelectionMarker selected={isSelected} />
                  <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected} wrap="truncate">
                    {entry.id}
                  </Text>
                </Box>
              );
            })}
            {hasScrollDown && <Text color={COLOR_TEXT_SUBTLE}>↓ more</Text>}
          </Box>

          {/* Right column: detail for the highlighted conversation */}
          <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
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
                    {getActiveMode(selectedEntry.appMode) !== 'standard' &&
                      ` • mode: ${getActiveMode(selectedEntry.appMode)}`}
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
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
};

export default ResumeSelectionMenu;
