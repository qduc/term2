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
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING, GLYPH_WARNING } from '../theme.js';

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
        1 +
        p.label.length +
        (!p.hasCredentials
          ? p.unavailableReason === 'missing-codex-login' || p.unavailableReason === 'missing-grok-login'
            ? 17
            : 9
          : 0) +
        1
      }
      renderTab={(p, isActive) => {
        const isDisabled = !p.hasCredentials;
        return (
          <Text
            inverse={isActive}
            color={isActive ? COLOR_ACCENT : isDisabled ? COLOR_DANGER : COLOR_TEXT_SUBTLE}
            bold={isActive}
            strikethrough={isDisabled}
          >
            {' '}
            {p.label}
            {isDisabled
              ? p.unavailableReason === 'missing-codex-login' || p.unavailableReason === 'missing-grok-login'
                ? ' (login required)'
                : ' (no key)'
              : ''}{' '}
          </Text>
        );
      }}
    />
  );

  return (
    <Box flexDirection="column">
      {tabBar}
      {activeTab && !activeTab.hasCredentials && (
        <Text color={COLOR_WARNING}>
          {GLYPH_WARNING} {activeTab.label} unavailable:{' '}
          {activeTab.unavailableReason === 'missing-codex-login'
            ? 'Not logged in on this host. Run `term2 --codex-login` to log in to Codex.'
            : activeTab.unavailableReason === 'missing-grok-login'
            ? 'Not logged in on this host. Run `term2 --grok-login` to log in to Grok.'
            : 'API key not configured on this host. Use Provider Management to configure it.'}
        </Text>
      )}
      {!canSwitchProvider && (
        <Box marginTop={0}>
          <Text color={COLOR_WARNING}>
            {GLYPH_WARNING} {providerSwitchDisabledMessage}
          </Text>
        </Box>
      )}
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        maxHeight={maxHeight}
        title="Select model"
        loading={loading}
        loadingText={loading ? `Loading models${provider ? ` from ${provider}` : ''}…` : 'Loading...'}
        error={error ? `Unable to load models: ${error}` : null}
        fallbackText={<Text color={COLOR_TEXT_SUBTLE}>No models match "{query || '*'}"</Text>}
        footer={
          <MenuFooter
            hints={[
              ['↑↓', 'navigate'],
              ['⏎', 'select'],
              ['tab', 'provider'],
              ['ctrl+r', 'refresh model list'],
              ['esc', 'cancel'],
            ]}
          />
        }
        footerOutsideBorder={true}
        renderItem={(item: ModelInfo, _actualIndex: number, isSelected: boolean) => (
          <Box key={item.id}>
            <SelectionMarker selected={isSelected} />
            <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected}>
              {item.id}
            </Text>
            {item.unavailableReason === 'missing-codex-login' ? (
              <Text color={COLOR_WARNING}> — unavailable: Not logged in on this host. Run `term2 --codex-login`.</Text>
            ) : item.unavailableReason === 'missing-grok-login' ? (
              <Text color={COLOR_WARNING}> — unavailable: Not logged in on this host. Run `term2 --grok-login`.</Text>
            ) : item.unavailableReason === 'missing-credentials' ? (
              <Text color={COLOR_WARNING}> — unavailable: API key not configured on this host</Text>
            ) : null}
            {item.name && <Text color={isSelected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}> — {item.name}</Text>}
          </Box>
        )}
      />
      {(error || (items.length === 0 && !loading)) && (
        <MenuFooter
          hints={[
            ['tab', 'switch provider'],
            ['esc', 'cancel'],
          ]}
        />
      )}
    </Box>
  );
};

export default ModelSelectionMenu;
