/**
 * Browser-safe copies of the TUI picker filters. The matching and ranking rules
 * come from `src/clients/tui/menus/subsequence-filter.ts`, `model-catalog.ts`
 * and `path-completion-filter.ts`; keep the two in step when either changes.
 * Path handling here is POSIX-style because file entries from the gateway use
 * forward slashes, and this module must not import Node's `path`.
 */
interface PathEntryLike {
  readonly path: string;
}

interface ModelEntryLike {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export const isSubsequenceMatch = (query: string, target: string): boolean => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

const BOUNDARY_REGEX = /[/.\-_]/u;

/** Returns -Infinity when the query is not a subsequence of the target. */
export const scoreSubsequence = (query: string, target: string): number => {
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (target[ti]!.toLowerCase() === q[qi]) {
      if (prevMatchIndex === ti - 1) {
        consecutive++;
        score += consecutive * 4;
      } else {
        consecutive = 0;
        score += 1;
      }

      const prev = ti > 0 ? target[ti - 1]! : null;
      const atBoundary =
        ti === 0 ||
        (prev !== null && BOUNDARY_REGEX.test(prev)) ||
        (prev !== null && prev === prev.toLowerCase() && target[ti] !== target[ti]!.toLowerCase());
      if (atBoundary) score += 8;

      prevMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return -Infinity;
  score -= target.length * 0.05;
  return score;
};

const baseName = (entryPath: string): string => {
  const cleaned = entryPath.replace(/[\\/]+$/u, '');
  if (!cleaned) return '';
  const parts = cleaned.split(/[\\/]/u);
  return parts.at(-1) ?? '';
};

const parentDirectory = (entryPath: string): string => {
  const cleaned = entryPath.replace(/[\\/]+$/u, '');
  const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (slash < 0) return '.';
  if (slash === 0) return '/';
  return cleaned.slice(0, slash);
};

/**
 * Rank path entries the way the TUI's `@` picker does: a basename match is
 * worth 3x, a leaf-directory match 1.5x and a whole-path match 0.5x. Empty
 * queries keep the source order, and results are truncated by the caller.
 */
export function filterPathEntries<T extends PathEntryLike>(
  entries: readonly T[],
  query: string,
  maxResults: number,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return entries.slice(0, maxResults);

  return entries
    .map((entry) => {
      const basename = baseName(entry.path);
      const parent = parentDirectory(entry.path);
      const leafDirectory = baseName(parent);
      const basenameScore = scoreSubsequence(trimmed, basename);
      const leafDirectoryScore = leafDirectory && leafDirectory !== '.' ? scoreSubsequence(trimmed, leafDirectory) : -Infinity;
      const pathScore = scoreSubsequence(trimmed, entry.path);
      const score = Math.max(
        basenameScore === -Infinity ? -Infinity : basenameScore * 3,
        leafDirectoryScore === -Infinity ? -Infinity : leafDirectoryScore * 1.5,
        pathScore === -Infinity ? -Infinity : pathScore * 0.5,
      );
      return { entry, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ entry }) => entry);
}

/** Bounded result count for the web `@` picker, matching the TUI path menu. */
export const MAX_FILE_MENTION_RESULTS = 100;

/** Rank file mentions from the workspace/session listing. */
export function filterFileMentions<T extends PathEntryLike>(entries: readonly T[], query: string): T[] {
  return filterPathEntries(entries, query, MAX_FILE_MENTION_RESULTS);
}

const providerOf = (labels: ReadonlyMap<string, string>, model: ModelEntryLike): string =>
  labels.get(model.provider) ?? model.provider;

/** 0 = whole-word literal hit, 1 = other literal hit, 2 = subsequence hit. */
function modelMatchTier(labels: ReadonlyMap<string, string>, model: ModelEntryLike, query: string): number {
  const label = providerOf(labels, model);
  const texts = [model.id, model.name ?? '', `${model.provider}/${model.id}`, `${label}/${model.id}`];
  let tier = 2;
  for (const text of texts) {
    const normalized = text.toLowerCase();
    let index = normalized.indexOf(query);
    while (index !== -1) {
      tier = 1;
      const before = [...normalized.slice(0, index)].at(-1);
      const after = [...normalized.slice(index + query.length)][0];
      if (
        (!before || !/[\p{L}\p{N}]/u.test(before)) &&
        (!after || !/[\p{L}\p{N}]/u.test(after))
      ) {
        return 0;
      }
      index = normalized.indexOf(query, index + 1);
    }
  }
  return tier;
}

const rankModelMatch = (model: ModelEntryLike, query: string): number | null => {
  const idScore = scoreSubsequence(query, model.id);
  const nameScore = model.name ? scoreSubsequence(query, model.name) : -Infinity;
  const weightedId = idScore === -Infinity ? -Infinity : idScore * 2;
  const weightedName = nameScore === -Infinity ? -Infinity : nameScore;
  if (weightedId === -Infinity && weightedName === -Infinity) return null;
  return weightedId >= weightedName ? weightedId : weightedName;
};

/**
 * Filter and rank models the way the TUI's unified catalog does: subsequence
 * matching over the model and its provider forms, then whole-word/substring/
 * subsequence tiers. Callers apply their own tab filter first.
 */
export function filterUnifiedModels<T extends ModelEntryLike>(
  models: readonly T[],
  query: string,
  labels: ReadonlyMap<string, string>,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...models];
  const lowered = trimmed.toLowerCase();

  const matches = models.filter((model) => {
    if (rankModelMatch(model, lowered) !== null) return true;
    const label = providerOf(labels, model);
    return (
      isSubsequenceMatch(trimmed, model.provider) ||
      isSubsequenceMatch(trimmed, label) ||
      isSubsequenceMatch(trimmed, `${model.provider}/${model.id}`) ||
      isSubsequenceMatch(trimmed, `${label}/${model.id}`)
    );
  });

  return matches
    .map((model) => ({ model, tier: modelMatchTier(labels, model, lowered) }))
    .sort((a, b) => a.tier - b.tier)
    .map(({ model }) => model);
}
