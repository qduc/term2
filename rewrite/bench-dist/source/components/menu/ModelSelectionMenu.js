import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { getAllProviders, getProvider } from '../../providers/index.js';
import { getAvailableProviderIds, hasProviderCredentials, resolveProviderCredentials, } from '../../utils/ai/provider-credentials.js';
import { useSetting } from '../../hooks/use-setting.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { GLYPH_FAVORITE, GLYPH_WARNING, useTheme } from '../theme.js';
import { FAVORITES_TAB_ID, serializeFavorite } from '../../services/models/model-favorites.js';
import { MODEL_TAB_LABELS, MODEL_TABS } from '../../services/models/model-tabs.js';
import { MODEL_MENU_NICKNAME_DRAFT_BINDINGS, MODEL_MENU_NICKNAME_EDIT_BINDINGS, MODEL_MENU_NICKNAME_REPLACE_BINDINGS, MODEL_MENU_PROVIDER_FALLBACK_BINDINGS, bindingHints, modelMenuFooterBindings, } from '../input/menu-bindings.js';
const EMPTY_FAVORITE_KEYS = new Set();
const ModelSelectionMenu = ({ items, selectedIndex, query, provider, modelTab, loading = false, error = null, warning = null, scrollOffset = 0, maxHeight = 10, canSwitchProvider = true, providerSwitchDisabledMessage = 'Provider can only be changed at the start of a new conversation (/clear to reset)', credentialRevision = 0, settingsService, favoriteKeys = EMPTY_FAVORITE_KEYS, nicknameLabels, nicknameDraft = null, currentKeys, showFilterLine = true, }) => {
    const theme = useTheme();
    const isFavoritesTab = modelTab === 'favorites' || provider === FAVORITES_TAB_ID;
    const isNicknamesTab = modelTab === 'nicknames';
    const isUnified = provider == null;
    const showProviderColumn = isFavoritesTab || isUnified;
    const providerLabels = useMemo(() => new Map(items.map((item) => [item.provider, getProvider(item.provider)?.label ?? item.provider])), [items]);
    const providerColumnWidth = Math.max(0, ...Array.from(providerLabels.values(), (label) => label.length)) + 2;
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
        const availableIds = new Set(getAvailableProviderIds(settingsService, sorted.map((p) => p.id)));
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
    const tabBar = (React.createElement(ScrollableTabBar, { items: tabItems, activeItemId: provider ?? '', getItemWidth: (p) => 1 +
            p.label.length +
            (!p.hasCredentials
                ? p.unavailableReason === 'missing-codex-login' || p.unavailableReason === 'missing-grok-login'
                    ? 17
                    : 9
                : 0) +
            1, renderTab: (p, isActive) => {
            const isDisabled = !p.hasCredentials;
            return (React.createElement(Text, { inverse: isActive, color: isActive ? theme.accent : isDisabled ? theme.danger : theme.textSubtle, bold: isActive, strikethrough: isDisabled },
                ' ',
                p.label,
                isDisabled
                    ? p.unavailableReason === 'missing-codex-login' || p.unavailableReason === 'missing-grok-login'
                        ? ' (login required)'
                        : ' (no key)'
                    : '',
                ' '));
        } }));
    const modelTabBar = modelTab && (React.createElement(ScrollableTabBar, { items: MODEL_TABS.map((id) => ({ id, label: MODEL_TAB_LABELS[id] })), activeItemId: modelTab, getItemWidth: (tab) => tab.label.length + 2, renderTab: (tab, isActive) => (React.createElement(Text, { inverse: isActive, color: isActive ? theme.accent : theme.textSubtle, bold: isActive },
            ' ',
            tab.label,
            ' ')) }));
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        modelTabBar,
        !isUnified && canSwitchProvider && tabBar,
        !isUnified && !canSwitchProvider && activeTab && (React.createElement(Text, { color: theme.textSubtle },
            "Provider: ",
            activeTab.label)),
        warning && (React.createElement(Text, { color: theme.warning },
            GLYPH_WARNING,
            " ",
            warning)),
        activeTab && !activeTab.hasCredentials && (React.createElement(Text, { color: theme.warning },
            GLYPH_WARNING,
            " ",
            activeTab.label,
            " unavailable:",
            ' ',
            activeTab.unavailableReason === 'missing-codex-login'
                ? 'Not logged in on this host. Run `term2 --codex-login` to log in to Codex.'
                : activeTab.unavailableReason === 'missing-grok-login'
                    ? 'Not logged in on this host. Run `term2 --grok-login` to log in to Grok.'
                    : 'API key not configured on this host. Use Provider Management to configure it.')),
        !canSwitchProvider && (React.createElement(Box, { marginTop: 0 },
            React.createElement(Text, { color: theme.warning },
                GLYPH_WARNING,
                " ",
                providerSwitchDisabledMessage))),
        showFilterLine && React.createElement(Text, { color: theme.textSubtle },
            "Filter: ",
            query || 'type to filter'),
        React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, scrollOffset: scrollOffset, maxHeight: maxHeight, title: "Select model", loading: loading && items.length === 0, loadingText: loading ? `Loading models${provider ? ` from ${provider}` : ' from all providers'}…` : 'Loading...', error: error ? `Unable to load models: ${error}` : null, fallbackText: isNicknamesTab && !query ? (React.createElement(Text, { color: theme.textSubtle }, "No nicknames yet \u2014 switch to All and press Ctrl+N on a model to name it.")) : isFavoritesTab && !query ? (React.createElement(Text, { color: theme.textSubtle }, "No favorites yet \u2014 press Ctrl+F on a model to add one.")) : (React.createElement(Text, { color: theme.textSubtle },
                "No models match \"",
                query || '*',
                "\"")), footer: React.createElement(MenuFooter, { hints: bindingHints(footerBindings) }), footerOutsideBorder: true, renderItem: (item, actualIndex, isSelected) => {
                const isFavorited = favoriteKeys.has(serializeFavorite(item.provider, item.id));
                const nickname = nicknameLabels?.get(serializeFavorite(item.provider, item.id));
                // Repeat the group label when scrolling starts partway through it.
                const startsVisibleGroup = actualIndex === scrollOffset || items[actualIndex - 1]?.provider !== item.provider;
                // Keep model details in one paragraph so they wrap in reading order.
                return (React.createElement(Box, { key: `${item.provider}/${item.id}`, width: "100%" },
                    showProviderColumn && (React.createElement(Box, { width: providerColumnWidth, maxWidth: "35%", flexShrink: 0, paddingRight: 1, marginRight: 1, borderStyle: "single", borderTop: false, borderBottom: false, borderLeft: false, borderColor: theme.border },
                        React.createElement(Text, { color: theme.text, bold: true, wrap: "truncate" }, startsVisibleGroup ? providerLabels.get(item.provider) : ' '))),
                    React.createElement(SelectionMarker, { selected: isSelected }),
                    favoriteKeys.size > 0 && (React.createElement(Box, { width: 2, flexShrink: 0 },
                        React.createElement(Text, { color: theme.accent, wrap: "truncate" }, isFavorited ? `${GLYPH_FAVORITE} ` : '  '))),
                    React.createElement(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
                        React.createElement(Text, null,
                            React.createElement(Text, { color: isSelected ? theme.accent : undefined, bold: isSelected }, item.id),
                            nickname && React.createElement(Text, { color: theme.accent },
                                " \u2014 aka \"",
                                nickname,
                                "\""),
                            currentKeys?.has(serializeFavorite(item.provider, item.id)) && (React.createElement(Text, { color: theme.success }, " (current)")),
                            item.unavailableReason === 'missing-codex-login' ? (React.createElement(Text, { color: theme.warning },
                                ' ',
                                "\u2014 unavailable: Not logged in on this host. Run `term2 --codex-login`.")) : item.unavailableReason === 'missing-grok-login' ? (React.createElement(Text, { color: theme.warning },
                                ' ',
                                "\u2014 unavailable: Not logged in on this host. Run `term2 --grok-login`.")) : item.unavailableReason === 'missing-credentials' ? (React.createElement(Text, { color: theme.warning }, " \u2014 unavailable: API key not configured on this host")) : null))));
            } }),
        nicknameDraft && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, null,
                React.createElement(Text, { color: theme.accent, bold: true },
                    "Nickname for ",
                    nicknameDraft.modelId,
                    ":"),
                React.createElement(Text, { color: theme.text },
                    " ",
                    nicknameDraft.text),
                React.createElement(Text, { color: theme.accent }, "\u258F")),
            nicknameDraft.error && (React.createElement(Text, { color: nicknameDraft.pendingReplace ? theme.warning : theme.danger }, nicknameDraft.error)))),
        !isUnified && (error || (items.length === 0 && !loading)) && (React.createElement(MenuFooter, { hints: bindingHints(MODEL_MENU_PROVIDER_FALLBACK_BINDINGS) }))));
};
export default ModelSelectionMenu;
//# sourceMappingURL=ModelSelectionMenu.js.map