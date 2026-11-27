import type { SettingItem } from './settings-catalog';

export interface SettingGroup {
  name?: string;
  items: SettingItem[];
}

/**
 * Groups a section's rows under their `group` names, in first-appearance order. A named group collects every
 * row with that name, even when other groups' rows sit between them in the catalog ("Shell and tools" does),
 * so a name never renders as two headings — or as two elements with the same React key. Rows with no group
 * stay in a run of their own, so they keep their place relative to the named groups around them.
 */
export function groupSettingItems(items: SettingItem[]): SettingGroup[] {
  const groups: SettingGroup[] = [];
  const named = new Map<string, SettingGroup>();
  for (const item of items) {
    if (item.group !== undefined) {
      const existing = named.get(item.group);
      if (existing) {
        existing.items.push(item);
        continue;
      }
      const group: SettingGroup = { name: item.group, items: [item] };
      named.set(item.group, group);
      groups.push(group);
      continue;
    }
    const last = groups.at(-1);
    if (last && last.name === undefined) last.items.push(item);
    else groups.push({ name: undefined, items: [item] });
  }
  return groups;
}
