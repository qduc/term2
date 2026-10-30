/**
 * Greedy horizontal tab expansion: starting from the active tab, expand left
 * and right to fit as many tabs as possible within the available terminal width.
 *
 * Each tab occupies `getItemWidth(item)` characters for its content, plus 3
 * characters for a separator (" │ ") between visible tabs, except edges which
 * use 4 characters for scroll indicators ("◀ " / " ▶").
 */
export function computeVisibleTabs(items, activeItemId, availableWidth, getItemWidth) {
    if (items.length === 0) {
        return { startIndex: 0, endIndex: -1, hasLeftScroll: false, hasRightScroll: false, visibleItems: [] };
    }
    const activeIndex = items.findIndex((item) => {
        // Support items with an `id` property (common case) or items where the
        // caller passes a predicate via the activeItemId comparison.
        const candidate = item;
        return typeof candidate.id === 'string' ? candidate.id === activeItemId : false;
    });
    const safeActiveIndex = activeIndex >= 0 ? activeIndex : 0;
    let start = safeActiveIndex;
    let end = safeActiveIndex;
    // +4 for the possible "◀ " and " ▶" scroll indicators
    let currentWidth = items[safeActiveIndex] ? getItemWidth(items[safeActiveIndex]) + 4 : 0;
    while (items.length > 0) {
        let expanded = false;
        if (end + 1 < items.length) {
            const rightWidth = getItemWidth(items[end + 1]) + 3; // " │ "
            if (currentWidth + rightWidth <= availableWidth) {
                currentWidth += rightWidth;
                end++;
                expanded = true;
            }
        }
        if (start - 1 >= 0) {
            const leftWidth = getItemWidth(items[start - 1]) + 3; // " │ "
            if (currentWidth + leftWidth <= availableWidth) {
                currentWidth += leftWidth;
                start--;
                expanded = true;
            }
        }
        if (!expanded)
            break;
    }
    return {
        startIndex: start,
        endIndex: end,
        hasLeftScroll: start > 0,
        hasRightScroll: end < items.length - 1,
        visibleItems: items.slice(start, end + 1),
    };
}
//# sourceMappingURL=compute-visible-tabs.js.map