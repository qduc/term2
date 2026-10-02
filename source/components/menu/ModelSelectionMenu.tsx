import React, { FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ModelInfo } from '../../services/model-service.js';
import { getAllProviders } from '../../providers/index.js';
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
import { GLYPH_FAVORITE, GLYPH_WARNING, useTheme } from '../theme.js';
import { FAVORITES_TAB_ID, serializeFavorite } from '../../services/models/model-favorites.js';
import { MODEL_TAB_LABELS, MODEL_TABS, type ModelTab } from '../../services/models/model-tabs.js';
import {
  MODEL_MENU_NICKNAME_DRAFT_BINDINGS,
  MODEL_MENU_NICKNAME_EDIT_BINDINGS,
  MODEL_MENU_NICKNAME_REPLACE_BINDINGS,
  MODEL_MENU_PROVIDER_FALLBACK_BINDINGS,
  bindingHints,
  modelMenuFooterBindings,
} from '../input/menu-bindings.js';

const EMPTY_FAVORITE_KEYS = new Set<string>();

type Props = {
  items: ModelInfo[];
  selectedIndex: number;
  query: string;
  provider?: string | null;
  /** Top-level cross-provider view. Omit for legacy provider-tab callers. */
  modelTab?: ModelTab;
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
  modelTab,
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
  const theme = useTheme();
  const isFavoritesTab = modelTab === 'favorites' || provider === FAVORITES_TAB_ID;
  const isNicknamesTab = modelTab === 'nicknames';
  const isUnified = provider == null;
  // The footer renders from declared binding tables (menu-bindings.ts), so a
  // hint cannot drift from the behavior the owning session implements. While
  // a nickname draft is open the draft editor owns the input row and only the
  // draft bindings are advertised.
  const footerBindings = nicknameDraft?.pendingReplace
    ? MODEL_MENU_NICKNAME_REPLACE_BINDINGS
    : nicknameDraft?.existingNickname
    ? MODEL_MENU_NICKNAME_EDIT_BINDINGS
    : nicknameDraft
    ? MODEL_MENU_NICKNAME_DRAFT_BINDINGS
    : modelMenuFooterBindings({
        tabDimension: modelTab != null,
        providerDimension: !isUnified,
        nicknameAvailable: isFavoritesTab || isNicknamesTab || isUnified,
      });
  const openAIApiKey = useSetting(settingsService, 'agent.openai.apiKey');
  const openRouterApiKey = useSetting(settingsService, 'agent.openrouter.apiKey');
  const tabItems = useMemo(() => {
    const sorted = getAllProviders();
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
            color={isActive ? theme.accent : isDisabled ? theme.danger : theme.textSubtle}
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

  const modelTabBar = modelTab && (
    <ScrollableTabBar
      items={MODEL_TABS.map((id) => ({ id, label: MODEL_TAB_LABELS[id] }))}
      activeItemId={modelTab}
      getItemWidth={(tab) => tab.label.length + 2}
      renderTab={(tab, isActive) => (
        <Text inverse={isActive} color={isActive ? theme.accent : theme.textSubtle} bold={isActive}>
          {' '}
          {tab.label}{' '}
        </Text>
      )}
    />
  );

  return (
    <Box flexDirection="column" width="100%">
      {modelTabBar}
      {!isUnified && canSwitchProvider && tabBar}
      {!isUnified && !canSwitchProvider && activeTab && (
        <Text color={theme.textSubtle}>Provider: {activeTab.label}</Text>
      )}
      {warning && (
        <Text color={theme.warning}>
          {GLYPH_WARNING} {warning}
        </Text>
      )}
      {activeTab && !activeTab.hasCredentials && (
        <Text color={theme.warning}>
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
          <Text color={theme.warning}>
            {GLYPH_WARNING} {providerSwitchDisabledMessage}
          </Text>
        </Box>
      )}
      <Text color={theme.textSubtle}>Filter: {query || 'type to filter'}</Text>
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
          isNicknamesTab && !query ? (
            <Text color={theme.textSubtle}>
              No nicknames yet — switch to All and press Ctrl+N on a model to name it.
            </Text>
          ) : isFavoritesTab && !query ? (
            <Text color={theme.textSubtle}>No favorites yet — press Ctrl+F on a model to add one.</Text>
          ) : (
            <Text color={theme.textSubtle}>No models match "{query || '*'}"</Text>
          )
        }
        footer={<MenuFooter hints={bindingHints(footerBindings)} />}
        footerOutsideBorder={true}
        renderItem={(item: ModelInfo, _actualIndex: number, isSelected: boolean) => {
          const isFavorited = favoriteKeys.has(serializeFavorite(item.provider, item.id));
          const nickname = nicknameLabels?.get(serializeFavorite(item.provider, item.id));
          // One paragraph, not sibling Texts: siblings shrink and wrap
          // independently, which drops characters and scrambles reading order
          // on narrow terminals. Nested Texts wrap as a unit, so the id,
          // provider, nickname, and display name stay intact and in order.
          return (
            <Box key={`${item.provider}/${item.id}`} width="100%">
              <SelectionMarker selected={isSelected} />
              {isFavorited && (
                <Box width={2} flexShrink={0}>
                  <Text color={theme.accent} wrap="truncate">
                    {GLYPH_FAVORITE}{' '}
                  </Text>
                </Box>
              )}
              <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
                <Text>
                  <Text color={isSelected ? theme.accent : undefined} bold={isSelected}>
                    {item.id}
                  </Text>
                  {nickname && <Text color={theme.accent}> — aka "{nickname}"</Text>}
                  {(isFavoritesTab || isUnified) && <Text color={theme.textSubtle}> ({item.provider})</Text>}
                  {item.unavailableReason === 'missing-codex-login' ? (
                    <Text color={theme.warning}>
                      {' '}
                      — unavailable: Not logged in on this host. Run `term2 --codex-login`.
                    </Text>
                  ) : item.unavailableReason === 'missing-grok-login' ? (
                    <Text color={theme.warning}>
                      {' '}
                      — unavailable: Not logged in on this host. Run `term2 --grok-login`.
                    </Text>
                  ) : item.unavailableReason === 'missing-credentials' ? (
                    <Text color={theme.warning}> — unavailable: API key not configured on this host</Text>
                  ) : null}
                </Text>
              </Box>
            </Box>
          );
        }}
      />
      {nicknameDraft && (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.accent} bold>
              Nickname for {nicknameDraft.modelId}:
            </Text>
            <Text color={theme.text}> {nicknameDraft.text}</Text>
            <Text color={theme.accent}>▏</Text>
          </Box>
          {nicknameDraft.error && (
            <Text color={nicknameDraft.pendingReplace ? theme.warning : theme.danger}>{nicknameDraft.error}</Text>
          )}
        </Box>
      )}
      {!isUnified && (error || (items.length === 0 && !loading)) && (
        <MenuFooter hints={bindingHints(MODEL_MENU_PROVIDER_FALLBACK_BINDINGS)} />
      )}
    </Box>
  );
};

export default ModelSelectionMenu;
