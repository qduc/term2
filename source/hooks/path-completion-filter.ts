import path from 'node:path';
import type { PathEntry } from '../services/file-service.js';

export const isSubsequenceMatch = (query: string, target: string): boolean => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

const BOUNDARY_REGEX = /[/.\-_]/;

// Returns -Infinity if query is not a subsequence of target.
// Higher score = better match. Rewards consecutive runs and word-boundary hits.
export const scoreSubsequence = (query: string, target: string): number => {
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (target[ti].toLowerCase() === q[qi]) {
      if (prevMatchIndex === ti - 1) {
        consecutive++;
        score += consecutive * 4;
      } else {
        consecutive = 0;
        score += 1;
      }

      const prev = ti > 0 ? target[ti - 1] : null;
      const atBoundary =
        ti === 0 ||
        (prev !== null && BOUNDARY_REGEX.test(prev)) ||
        (prev !== null && prev === prev.toLowerCase() && target[ti] !== target[ti].toLowerCase());
      if (atBoundary) score += 8;

      prevMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return -Infinity;

  score -= target.length * 0.05;
  return score;
};

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
