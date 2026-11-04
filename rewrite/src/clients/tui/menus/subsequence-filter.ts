export const isSubsequenceMatch = (query: string, target: string): boolean => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

export const BOUNDARY_REGEX = /[/.\-_]/;

/**
 * Returns -Infinity if query is not a subsequence of target.
 * Higher score = better match. Rewards consecutive runs and word-boundary hits.
 */
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
