import React, { FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ModelInfo } from '../services/model-service.js';
import { getAllProviders, sortProvidersByOrder } from '../providers/index.js';
import { hasProviderCredentials } from '../utils/provider-credentials.js';
import type { SettingsService } from '../services/settings-service.js';
import { MenuContainer } from './Common/MenuContainer.js';
import { ScrollableTabBar } from './Common/ScrollableTabBar.js';

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
  const tabItems = useMemo(() => {
    const all = getAllProviders();
    const providerOrder = settingsService.get<string[]>('providerOrder') ?? [];
    const sorted =
      providerOrder.length > 0
        ? sortProvidersByOrder(
            all.map((p) => p.id),
            providerOrder,
          )
            .map((id) => all.find((p) => p.id === id)!)
            .filter(Boolean)
        : all;
    return sorted.map((p) => ({
      id: p.id,
      label: p.label,
      hasCredentials: hasProviderCredentials(settingsService, p.id),
    }));
  }, [settingsService]);

  const tabBar = (
    <ScrollableTabBar
      items={tabItems}
      activeItemId={provider ?? ''}
      getItemWidth={(p) => 1 + p.label.length + (!p.hasCredentials ? 9 : 0) + 1}
      renderTab={(p, isActive) => {
        const isDisabled = !p.hasCredentials;
        return (
          <Text
            inverse={isActive}
            color={isActive ? 'magenta' : isDisabled ? 'red' : '#64748b'}
            bold={isActive}
            strikethrough={isDisabled}
          >
            {' '}
            {p.label}
            {isDisabled ? ' (no key)' : ''}{' '}
          </Text>
        );
      }}
      hint={canSwitchProvider ? 'Tab/←→ → switch provider' : undefined}
    />
  );

  return (
    <Box flexDirection="column">
      {tabBar}
      {!canSwitchProvider && (
        <Box marginTop={0}>
          <Text color="yellow">
            ⚠ Provider can only be changed at the start of a new conversation (/clear to reset)
          </Text>
        </Box>
      )}
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        maxHeight={maxHeight}
        borderColor="magenta"
        loading={loading}
        loadingText={loading ? `Loading models${provider ? ` from ${provider}` : ''}…` : 'Loading...'}
        error={error ? `Unable to load models: ${error}` : null}
        fallbackText={<Text color="#64748b">No models match "{query || '*'}"</Text>}
        footer={<Text color="#64748b">Enter → set model · Esc → cancel · ↑↓ → scroll</Text>}
        footerOutsideBorder={true}
        renderItem={(item: ModelInfo, _actualIndex: number, isSelected: boolean) => (
          <Box key={item.id}>
            <Text inverse={isSelected} color={isSelected ? 'magenta' : undefined} bold={isSelected}>
              {item.id}
            </Text>
            {item.name && <Text color={isSelected ? 'white' : '#64748b'}> — {item.name}</Text>}
          </Box>
        )}
      />
      {(error || (items.length === 0 && !loading)) && (
        <Text color="#64748b">Tab/←→ → switch provider · Esc → cancel</Text>
      )}
    </Box>
  );
};

export default ModelSelectionMenu;
