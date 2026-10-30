import { serializeFavorite } from './model-favorites.js';
/**
 * Unified model-picker tabs, left to right. Tab and Right advance one step;
 * Left moves one step backward. Both directions wrap at the ends.
 */
export const MODEL_TABS = ['favorites', 'nicknames', 'all'];
export const MODEL_TAB_LABELS = {
    favorites: 'Favorites',
    nicknames: 'Nicknames',
    all: 'All',
};
export function nextModelTab(tab) {
    const index = MODEL_TABS.indexOf(tab);
    return MODEL_TABS[(index + 1) % MODEL_TABS.length];
}
export function previousModelTab(tab) {
    const index = MODEL_TABS.indexOf(tab);
    return MODEL_TABS[(index - 1 + MODEL_TABS.length) % MODEL_TABS.length];
}
/**
 * Models pinned ahead of catalog rows. Favorites are always pinned. Nickname
 * targets are pinned only on the Nicknames tab, so a name for a model the
 * catalog has not loaded yet still appears there without also floating that
 * model to the top of All.
 */
export function pinnedModelsForTab(tab, favorites, nicknames) {
    return tab === 'nicknames' ? [...favorites, ...nicknames] : [...favorites];
}
export function selectModelsForTab(models, tab, keys) {
    if (tab === 'favorites') {
        return models.filter((model) => keys.favoriteKeys.has(serializeFavorite(model.provider, model.id)));
    }
    if (tab === 'nicknames') {
        return models.filter((model) => keys.nicknameKeys.has(serializeFavorite(model.provider, model.id)));
    }
    return [...models];
}
//# sourceMappingURL=model-tabs.js.map