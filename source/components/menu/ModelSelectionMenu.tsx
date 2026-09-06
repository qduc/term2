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
import type { NicknameDraftState } from '../../hooks/use-model-selection.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import {
  COLOR_ACCENT,
  COLOR_DANGER,
  COLOR_TEXT,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
  GLYPH_FAVORITE,
  GLYPH_WARNING,
} from '../theme.js';
import { FAVORITES_TAB_ID, serializeFavorite } from '../../services/models/model-favorites.js';

const EMPTY_FAVORITE_KEYS = new Set<string>();

type Props = {
  items: ModelInfo[];
  selectedIndex: number;
  query: string;
  provider?: string | null;
  loading?: boolean;
  error?: string | null;
  warning?: string | null;
  scrollOffset?: number;
  maxHeight?: number;
  canSwitchProvider?: boolean;
  providerSwitchDisabledMessage?: string;
  credentialRevision?: number;
  settingsService: SettingsService;
  /** Set of `provider/modelId` strings for the favorited-state marker, shown on every tab. */
  favoriteKeys?: Set<string>;
  /** Map of `provider/modelId` -> nickname, rendered on rows on every tab. */
  nicknameLabels?: Map<string, string>;
  /** When set, the inline nickname editor owns an input row below the list. */
  nicknameDraft?: NicknameDraftState | null;
};

const ModelSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  query,
  provider,
  loading = false,
  error = null,
  warning = null,
  scrollOffset = 0,
  maxHeight = 10,
  canSwitchProvider = true,
  providerSwitchDisabledMessage = 'Provider can only be changed at the start of a new conversation (/clear to reset)',
  credentialRevision = 0,
  settingsService,
  favoriteKeys = EMPTY_FAVORITE_KEYS,
  nicknameLabels,
  nicknameDraft = null,
}) => {
  const isFavoritesTab = provider === FAVORITES_TAB_ID;
  const isUnified = provider == null;
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
    const providerTabs = sorted
      .filter((p) => availableIds.has(p.id) || p.id === provider)
      .map((p) => ({
        id: p.id,
        label: p.label,
        hasCredentials: hasProviderCredentials(settingsService, p.id),
        unavailableReason: resolveProviderCredentials(settingsService, p.id).unavailableReason,
      }));
    // Pinned leftmost, ahead of every real provider: pure presentation, no
    // credential check (it never fails to load — there's nothing to load).
    return [
      { id: FAVORITES_TAB_ID, label: 'Favorites', hasCredentials: true, unavailableReason: undefined },
      ...providerTabs,
    ];
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
      {!isUnified && canSwitchProvider && tabBar}
      {!isUnified && !canSwitchProvider && activeTab && (
        <Text color={COLOR_TEXT_SUBTLE}>Provider: {activeTab.label}</Text>
      )}
      {warning && (
        <Text color={COLOR_WARNING}>
          {GLYPH_WARNING} {warning}
        </Text>
      )}
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
        loading={loading && items.length === 0}
        loadingText={
          loading ? `Loading models${provider ? ` from ${provider}` : ' from all providers'}…` : 'Loading...'
        }
        error={error ? `Unable to load models: ${error}` : null}
        fallbackText={
          isFavoritesTab && !query ? (
            <Text color={COLOR_TEXT_SUBTLE}>No favorites yet — press ctrl+f on a model to add one.</Text>
          ) : (
            <Text color={COLOR_TEXT_SUBTLE}>No models match "{query || '*'}"</Text>
          )
        }
        footer={
          <MenuFooter
            hints={[
              ['↑↓', 'navigate'],
              ['⏎', 'select'],
              ...(!isUnified ? ([['←→', 'provider']] as [string, string][]) : []),
              // In unified mode any favorited row can be named.
              ...(isFavoritesTab || isUnified ? ([['ctrl+n', 'nickname']] as [string, string][]) : []),
              ['ctrl+f', 'favorite'],
              ['ctrl+r', 'refresh model list'],
              ['esc', 'cancel'],
            ]}
          />
        }
        footerOutsideBorder={true}
        renderItem={(item: ModelInfo, _actualIndex: number, isSelected: boolean) => {
          const isFavorited = favoriteKeys.has(serializeFavorite(item.provider, item.id));
          const nickname = nicknameLabels?.get(serializeFavorite(item.provider, item.id));
          return (
            <Box key={`${item.provider}/${item.id}`}>
              <SelectionMarker selected={isSelected} />
              {isFavorited && <Text color={COLOR_ACCENT}>{GLYPH_FAVORITE} </Text>}
              <Text color={isSelected ? COLOR_ACCENT : undefined} bold={isSelected}>
                {item.id}
              </Text>
              {nickname && <Text color={COLOR_ACCENT}> — aka "{nickname}"</Text>}
              {(isFavoritesTab || isUnified) && <Text color={COLOR_TEXT_SUBTLE}> ({item.provider})</Text>}
              {item.unavailableReason === 'missing-codex-login' ? (
                <Text color={COLOR_WARNING}>
                  {' '}
                  — unavailable: Not logged in on this host. Run `term2 --codex-login`.
                </Text>
              ) : item.unavailableReason === 'missing-grok-login' ? (
                <Text color={COLOR_WARNING}> — unavailable: Not logged in on this host. Run `term2 --grok-login`.</Text>
              ) : item.unavailableReason === 'missing-credentials' ? (
                <Text color={COLOR_WARNING}> — unavailable: API key not configured on this host</Text>
              ) : null}
              {item.name && <Text color={isSelected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}> — {item.name}</Text>}
            </Box>
          );
        }}
      />
      {(isFavoritesTab || isUnified) && nicknameDraft && (
        <Box flexDirection="column">
          <Box>
            <Text color={COLOR_ACCENT} bold>
              Nickname for {nicknameDraft.modelId}:
            </Text>
            <Text color={COLOR_TEXT}> {nicknameDraft.text}</Text>
            <Text color={COLOR_ACCENT}>▏</Text>
          </Box>
          {nicknameDraft.error && <Text color={COLOR_DANGER}>{nicknameDraft.error}</Text>}
        </Box>
      )}
      {!isUnified && (error || (items.length === 0 && !loading)) && (
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
