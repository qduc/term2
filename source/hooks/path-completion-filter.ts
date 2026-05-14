import path from 'node:path';
import type { PathEntry } from '../services/file-service.js';
import { scoreSubsequence } from '../utils/subsequence-filter.js';

export { isSubsequenceMatch, scoreSubsequence } from '../utils/subsequence-filter.js';

export const filterPathEntries = (entries: PathEntry[], query: string, maxResults: number): PathEntry[] => {
  const trimmed = query.trim();
  if (!trimmed) {
    return entries.slice(0, maxResults);
  }

  return entries
    .map((entry) => {
      const basename = path.basename(entry.path);
      const leafDirectory = path.basename(path.dirname(entry.path));

      const basenameScore = scoreSubsequence(trimmed, basename);
      const leafDirectoryScore =
        leafDirectory && leafDirectory !== '.' ? scoreSubsequence(trimmed, leafDirectory) : -Infinity;
      const pathScore = scoreSubsequence(trimmed, entry.path);

      const weightedBasename = basenameScore === -Infinity ? -Infinity : basenameScore * 3;
      const weightedLeafDirectory = leafDirectoryScore === -Infinity ? -Infinity : leafDirectoryScore * 1.5;
      const weightedPath = pathScore === -Infinity ? -Infinity : pathScore * 0.5;

      const score = Math.max(weightedBasename, weightedLeafDirectory, weightedPath);
      return { entry, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ entry }) => entry);
};
