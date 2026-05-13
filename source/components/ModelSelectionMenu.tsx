import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { ModelInfo } from '../services/model-service.js';
import { getAllProviders } from '../providers/index.js';
import { hasProviderCredentials } from '../utils/provider-credentials.js';
import type { SettingsService } from '../services/settings-service.js';

type Props = {
  items: ModelInfo[];
  selectedIndex: number;
  query: string;
  provider?: string | null;
  loading?: boolean;
  error?: string | null;
  scrollOffset?: number;
  maxHeight?: number;
  canSwitchProvider?: boolean;
  settingsService: SettingsService;
};

const ProviderTabs: FC<{
  activeProvider?: string | null;
  canSwitch?: boolean;
  settingsService: SettingsService;
}> = ({ activeProvider, canSwitch = true, settingsService }) => {
  const providers = getAllProviders().map((p) => ({
    id: p.id,
    label: p.label,
    hasCredentials: hasProviderCredentials(settingsService, p.id),
  }));

  const terminalWidth = process.stdout.columns || 80;
  const labelLength = canSwitch ? 'Tab/←→ → switch provider'.length : 0;
  const availableWidth = terminalWidth - labelLength - 2;

  const getTabWidth = (p: (typeof providers)[0]) => {
    return 1 + p.label.length + (!p.hasCredentials ? 9 : 0) + 1; // " {label}{ (no key)} "
  };

  const activeIndex = providers.findIndex((p) => p.id === activeProvider);
  const safeActiveIndex = activeIndex >= 0 ? activeIndex : 0;

  let start = safeActiveIndex;
  let end = safeActiveIndex;
  let currentWidth = getTabWidth(providers[safeActiveIndex]) + 4; // +4 for "◀ " and " ▶"

  while (true) {
    let expanded = false;
    // Try to expand right
    if (end + 1 < providers.length) {
      const rightWidth = getTabWidth(providers[end + 1]) + 3; // " │ "
      if (currentWidth + rightWidth <= availableWidth) {
        currentWidth += rightWidth;
        end++;
        expanded = true;
      }
    }
    // Try to expand left
    if (start - 1 >= 0) {
      const leftWidth = getTabWidth(providers[start - 1]) + 3; // " │ "
      if (currentWidth + leftWidth <= availableWidth) {
        currentWidth += leftWidth;
        start--;
        expanded = true;
      }
    }
    if (!expanded) break;
  }

  const visibleProviders = providers.slice(start, end + 1);
  const hasLeftScroll = start > 0;
  const hasRightScroll = end < providers.length - 1;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          {hasLeftScroll && <Text color="#64748b">◀ </Text>}
          {visibleProviders.map((provider, index) => {
            const isActive = provider.id === activeProvider;
            const isDisabled = !provider.hasCredentials;
            return (
              <Box key={provider.id}>
                <Text
                  inverse={isActive}
                  color={isActive ? 'magenta' : isDisabled ? 'red' : '#64748b'}
                  bold={isActive}
                  strikethrough={isDisabled}
                >
                  {' '}
                  {provider.label}
                  {isDisabled ? ' (no key)' : ''}{' '}
                </Text>
                {index < visibleProviders.length - 1 && <Text color="#64748b">{' │ '}</Text>}
              </Box>
            );
          })}
          {hasRightScroll && <Text color="#64748b"> ▶</Text>}
        </Box>
        {canSwitch && <Text color="#64748b">Tab/←→ → switch provider</Text>}
      </Box>
      {!canSwitch && (
        <Box marginTop={0}>
          <Text color="yellow">
            ⚠ Provider can only be changed at the start of a new conversation (/clear to reset)
          </Text>
        </Box>
      )}
    </Box>
  );
};

const ModelSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  query,
  provider,
  loading = false,
  error = null,
  scrollOffset = 0,
  maxHeight = 10,
  canSwitchProvider = true,
  settingsService,
}) => {
  const header = (
    <ProviderTabs activeProvider={provider} canSwitch={canSwitchProvider} settingsService={settingsService} />
  );

  if (loading) {
    return (
      <Box flexDirection="column">
        {header}
        <Box borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta">Loading models{provider ? ` from ${provider}` : ''}…</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        {header}
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">Unable to load models: {error}</Text>
        </Box>
        <Text color="#64748b">Tab/←→ → switch provider · Esc → cancel</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        {header}
        <Box borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="#64748b">No models match "{query || '*'}"</Text>
        </Box>
        <Text color="#64748b">Tab/←→ → switch provider · Esc → cancel</Text>
      </Box>
    );
  }

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + maxHeight < items.length;

  return (
    <Box flexDirection="column">
      {header}
      <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text color="#64748b">
            {items.length} suggestion{items.length === 1 ? '' : 's'}
          </Text>
          {items.length > maxHeight && (
            <Text color="#64748b">
              {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, items.length)}/{items.length}
            </Text>
          )}
        </Box>
        {hasScrollUp && <Text color="#64748b">↑ {scrollOffset} more</Text>}
        {visibleItems.map((item, visibleIndex) => {
          const actualIndex = scrollOffset + visibleIndex;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Box key={item.id}>
              <Text inverse={isSelected} color={isSelected ? 'magenta' : undefined} bold={isSelected}>
                {item.id}
              </Text>
              {item.name && <Text color={isSelected ? 'white' : '#64748b'}> — {item.name}</Text>}
            </Box>
          );
        })}
        {hasScrollDown && <Text color="#64748b">↓ {items.length - scrollOffset - maxHeight} more</Text>}
      </Box>
      <Text color="#64748b">Enter → set model · Esc → cancel · ↑↓ → scroll</Text>
    </Box>
  );
};

export default ModelSelectionMenu;
