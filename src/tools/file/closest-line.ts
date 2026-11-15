/**
 * Nearest-line hints for edit tools that could not find text in a file.
 *
 * A model that is told only "not found" re-reads the whole file to repair its edit. Naming the closest
 * line, with its line number, usually removes that request. A hint is given only above a similarity
 * threshold: a distant line would send the model to the wrong place, so below it nothing is offered.
 *
 * Similarity is the Dice coefficient over character bigrams of whitespace-normalised lines. The work is
 * bounded: lines are compared on at most MAX_LINE_CHARS characters, and a file larger than MAX_SCAN_CHARS
 * characters gets no hint at all (it is not split, and no partial scan can claim a line is absent).
 */

const MIN_SIMILARITY = 0.6;
const MIN_LINE_CHARS = 4;
const MAX_LINE_CHARS = 300;
const MAX_SCAN_CHARS = 1_500_000;
const MAX_SHOWN_CHARS = 100;

export interface ClosestLine {
  /** 1-based line number in the file. */
  readonly line: number;
  /** The file's line, trimmed and shortened for display. */
  readonly text: string;
  readonly similarity: number;
}

const normalize = (line: string): string => line.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function shorten(text: string): string {
  return text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}…` : text;
}

/** The file line most similar to `needle` (at or above the threshold), or undefined when nothing is close. */
function findClosestLine(needle: string, fileLines: readonly string[]): ClosestLine | undefined {
  const target = normalize(needle);
  if (target.length < MIN_LINE_CHARS) return undefined;
  const targetGrams = bigrams(target);
  const targetCount = target.length - 1;
  let best: ClosestLine | undefined;
  for (let i = 0; i < fileLines.length; i++) {
    const raw = fileLines[i]!;
    const candidate = normalize(raw);
    if (candidate.length < MIN_LINE_CHARS) continue;
    const candidateCount = candidate.length - 1;
    // Dice cannot reach the threshold when the lengths differ this much.
    if ((2 * Math.min(candidateCount, targetCount)) / (candidateCount + targetCount) < MIN_SIMILARITY) continue;
    const remaining = new Map(targetGrams);
    let shared = 0;
    for (let j = 0; j < candidate.length - 1; j++) {
      const gram = candidate.slice(j, j + 2);
      const left = remaining.get(gram);
      if (left) {
        shared++;
        remaining.set(gram, left - 1);
      }
    }
    const similarity = (2 * shared) / (candidateCount + targetCount);
    if (similarity >= MIN_SIMILARITY && (!best || similarity > best.similarity)) {
      best = { line: i + 1, text: shorten(candidate), similarity };
    }
  }
  return best;
}

/** True when the whole file is within the scan budget, so "no such line" and "nearest line" are claims about all of it. */
function withinBudget(lines: readonly string[]): boolean {
  let chars = 0;
  for (const line of lines) {
    chars += line.length + 1;
    if (chars > MAX_SCAN_CHARS) return false;
  }
  return true;
}

/**
 * `closest is line 41: "text"` for a needle, or a plain statement that nothing is close. Empty for a file
 * beyond the scan budget: a partial scan could name a wrong line or call a line absent that exists later.
 */
export function describeClosestLine(needle: string, fileLines: readonly string[]): string {
  if (!withinBudget(fileLines)) return '';
  const closest = findClosestLine(needle, fileLines);
  return closest ? `closest is line ${closest.line}: "${closest.text}"` : 'no similar line found in the file';
}

/**
 * For a multi-line search text: the first line that appears nowhere in the file (compared trimmed),
 * with its nearest file line. Empty when every line exists somewhere (the mismatch is then order,
 * spacing between lines or a gap, which a single nearest line would misreport), and for a file beyond the
 * scan budget (checked before the file is split, so a huge file costs nothing).
 */
export function describeSearchMismatch(searchContent: string, fileContent: string): string {
  if (fileContent.length > MAX_SCAN_CHARS) return '';
  const fileLines = fileContent.split(/\r?\n/);
  const present = new Set(fileLines.map((line) => line.trim()));
  const searchLines = searchContent.split(/\r?\n/);
  for (let i = 0; i < searchLines.length; i++) {
    const trimmed = searchLines[i]!.trim();
    if (!trimmed || trimmed === '<...>' || present.has(trimmed)) continue;
    const where = searchLines.length > 1 ? `search line ${i + 1}` : 'search text';
    return `For ${where} ("${shorten(trimmed)}"), ${describeClosestLine(trimmed, fileLines)}.`;
  }
  return '';
}
