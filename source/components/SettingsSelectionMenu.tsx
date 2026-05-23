import React, { FC } from 'react';
import fs from 'node:fs';
import { Box, Text } from 'ink';
import type { SettingCompletionItem } from '../hooks/use-settings-completion.js';
import { SETTING_KEYS } from '../services/settings-service.js';
import { getRtkBinaryPath } from '../services/rtk-service.js';
import { MenuContainer } from './Common/MenuContainer.js';

type Props = {
  items: SettingCompletionItem[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
};

function titleCaseCategory(category: string): string {
  if (!category || category === 'other') return 'Other Settings';
  if (category === 'common') return 'Common Settings';
  if (category === 'ui') return 'User Interface';
  if (category === 'webSearch') return 'Web Search';
  if (category === 'agent') return 'Agent Configuration';
  if (category === 'openai') return 'OpenAI Provider';
  if (category === 'anthropic') return 'Anthropic Provider';
  if (category === 'openrouter') return 'OpenRouter Provider';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function getCategoryForKey(key: string): string {
  const COMMON_KEYS = new Set([
    'agent.model',
    'agent.reasoningEffort',
    'agent.temperature',
    'agent.maxTurns',
    'logging.logLevel',
    'shell.timeout',
  ]);
  if (COMMON_KEYS.has(key)) return 'common';
  return key.split('.')[0] || 'other';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function formatValue(
  value: string | number | boolean,
  key: string,
): {
  text: string;
  color?: string;
} {
  if (typeof value === 'boolean') {
    let text = value ? 'ON' : 'OFF';
    if (value && key === SETTING_KEYS.SHELL_USE_RTK_COMPRESSION && fs.existsSync(getRtkBinaryPath())) {
      text += ' (installed)';
    }
    return {
      text,
      color: value ? 'green' : 'red',
    };
  }
  if (typeof value === 'number') {
    return { text: String(value), color: 'yellow' };
  }
  return { text: truncate(value, 40), color: 'cyan' };
}

const VISIBLE_COUNT = 10;
const KEY_COL_WIDTH = 32;

const SettingsSelectionMenu: FC<Props> = ({ items, selectedIndex, scrollOffset = 0, query }) => {
  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={VISIBLE_COUNT}
      borderColor={items.length === 0 ? 'red' : 'cyan'}
      title={
        <Box>
          <Text bold color="cyan">
            ⚙ Settings
          </Text>
          <Text color="gray"> · </Text>
          {query ? (
            <Text>
              Searching: "
              <Text color="white" bold>
                {query}
              </Text>
              "
            </Text>
          ) : (
            <Text color="gray">Type to filter</Text>
          )}
        </Box>
      }
      fallbackText={
        <Box flexDirection="column">
          <Text bold color="red">
            No settings found
          </Text>
          <Text color="gray">No settings match "{query}"</Text>
        </Box>
      }
      footer={
        <Text color="gray" dimColor>
          Use <Text bold>↑↓</Text> to navigate, <Text bold>Enter</Text> to edit, <Text bold>Esc</Text> to close
        </Text>
      }
      footerOutsideBorder={false}
      renderItem={(item, actualIndex, isSelected) => {
        const category = getCategoryForKey(item.key);
        const prevCategory = actualIndex > 0 ? getCategoryForKey(items[actualIndex - 1]!.key) : null;
        const showHeader = actualIndex === scrollOffset || category !== prevCategory;

        const valueObj = item.currentValue !== undefined ? formatValue(item.currentValue, item.key) : null;
        const paddedKey =
          item.key.length > KEY_COL_WIDTH
            ? truncate(item.key, KEY_COL_WIDTH).padEnd(KEY_COL_WIDTH, ' ')
            : item.key.padEnd(KEY_COL_WIDTH, ' ');

        return (
          <Box key={item.key} flexDirection="column">
            {showHeader && (
              <Box marginTop={actualIndex === scrollOffset ? 0 : 1} marginBottom={0}>
                <Text color="#22d3ee" bold underline>
                  {titleCaseCategory(category)}
                </Text>
              </Box>
            )}

            <Box flexDirection="column">
              <Box>
                <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
                <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
                  {paddedKey}
                </Text>
                {valueObj && <Text color={isSelected ? 'white' : 'gray'}>{valueObj.text}</Text>}
              </Box>

              {isSelected && item.description && (
                <Box marginLeft={2} marginTop={0}>
                  <Text color="#7dd3fc" dimColor italic>
                    └── {item.description}
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        );
      }}
    />
  );
};

export default SettingsSelectionMenu;
