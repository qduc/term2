import React, { FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ModelInfo } from '../../services/model-service.js';
import { getAllProviders, sortProvidersByOrder } from '../../providers/index.js';
import {
  getAvailableProviderIds,
  hasProviderCredentials,
  resolveProviderCredentials,
} from '../../utils/ai/provider-credentials.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import { useSetting } from '../../hooks/use-setting.js';
import { MenuContainer } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';

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
  providerSwitchDisabledMessage?: string;
  credentialRevision?: number;
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
  providerSwitchDisabledMessage = 'Provider can only be changed at the start of a new conversation (/clear to reset)',
  credentialRevision = 0,
  settingsService,
}) => {
  const openAIApiKey = useSetting(settingsService, 'agent.openai.apiKey');
  const openRouterApiKey = useSetting(settingsService, 'agent.openrouter.apiKey');
  const tabItems = useMemo(() => {
    const all = getAllProviders();
    const providerOrder = settingsService.get('providerOrder') ?? [];
    const sorted =
      providerOrder.length > 0
        ? sortProvidersByOrder(
            all.map((p) => p.id),
            providerOrder,
          )
            .map((id) => all.find((p) => p.id === id)!)
            .filter(Boolean)
        : all;
    const availableIds = new Set(
      getAvailableProviderIds(
        settingsService,
        sorted.map((p) => p.id),
      ),
    );
    return sorted
      .filter((p) => availableIds.has(p.id) || p.id === provider)
      .map((p) => ({
        id: p.id,
        label: p.label,
        hasCredentials: hasProviderCredentials(settingsService, p.id),
        unavailableReason: resolveProviderCredentials(settingsService, p.id).unavailableReason,
      }));
  }, [credentialRevision, openAIApiKey, openRouterApiKey, provider, settingsService]);

  const activeTab = tabItems.find((item) => item.id === provider);

  const tabBar = (
    <ScrollableTabBar
      items={tabItems}
      activeItemId={provider ?? ''}
      getItemWidth={(p) =>
        1 + p.label.length + (!p.hasCredentials ? (p.unavailableReason === 'missing-codex-login' ? 17 : 9) : 0) + 1
      }
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
            {isDisabled ? (p.unavailableReason === 'missing-codex-login' ? ' (login required)' : ' (no key)') : ''}{' '}
          </Text>
        );
      }}
      hint={canSwitchProvider ? 'Tab/←→ → switch provider' : undefined}
    />
  );

  return (
    <Box flexDirection="column">
      {tabBar}
      {activeTab && !activeTab.hasCredentials && (
        <Text color="yellow">
          ⚠ {activeTab.label} unavailable:{' '}
          {activeTab.unavailableReason === 'missing-codex-login'
            ? 'Not logged in on this host. Run `npx @openai/codex login` to log in to Codex.'
            : 'API key not configured on this host. Use Provider Management to configure it.'}
        </Text>
      )}
      {!canSwitchProvider && (
        <Box marginTop={0}>
          <Text color="yellow">⚠ {providerSwitchDisabledMessage}</Text>
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
        footer={
          <Text color="#64748b">Enter → set model · Esc → cancel · ↑↓ → scroll · Ctrl+R → refresh model list</Text>
        }
        footerOutsideBorder={true}
        renderItem={(item: ModelInfo, _actualIndex: number, isSelected: boolean) => (
          <Box key={item.id}>
            <Text inverse={isSelected} color={isSelected ? 'magenta' : undefined} bold={isSelected}>
              {item.id}
            </Text>
            {item.unavailableReason === 'missing-codex-login' ? (
              <Text color="yellow"> — unavailable: Not logged in on this host. Run `npx @openai/codex login`.</Text>
            ) : item.unavailableReason === 'missing-credentials' ? (
              <Text color="yellow"> — unavailable: API key not configured on this host</Text>
            ) : null}
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
