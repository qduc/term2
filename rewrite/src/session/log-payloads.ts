/** Version-2 physical string sharing. Facts presented to callers are always hydrated.
 * References address only an accepted same-turn string (or an earlier string in
 * this fact), never a future item. Thus tool_finished remains crash-complete even
 * when the process dies before its provider item. Deltas/history edits stay literal.
 */
import type { Fact, FactLine } from './facts.js';

type Path = readonly (string | number)[];
type Source = { readonly seq: number; readonly path: Path; readonly jsonPath?: Path; readonly jsonEscape?: true };
export type PayloadReference = {
  readonly path: Path;
  readonly source: Source;
  readonly start: number;
  readonly length: number;
  readonly prefix: string;
  readonly suffix: string;
};
type Candidate = { readonly source: Source; readonly value: string };
const MIN_SHARED = 200;

function strings(value: unknown, visit: (text: string, path: Path) => void, path: Path = []): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((child, index) => strings(child, visit, [...path, index]));
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) strings(child, visit, [...path, key]);
}

function at(value: unknown, path: Path): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error('payload reference has a missing source/target path');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function replace(value: unknown, path: Path, next: unknown): void {
  if (!path.length) throw new Error('payload reference cannot replace a fact');
  const parent = at(value, path.slice(0, -1));
  const key = path.at(-1)!;
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key))
    throw new Error('payload reference has a missing target path');
  Object.defineProperty(parent, key, { value: next, enumerable: true, writable: true, configurable: true });
}

function turn(fact: Fact): string | undefined {
  if (fact.type === 'branch_event') return fact.fact.turnId;
  return 'turnId' in fact ? fact.turnId : undefined;
}
function eligible(fact: Fact): boolean {
  const type = fact.type === 'branch_event' ? fact.fact.type : fact.type;
  return type !== 'text_delta' && type !== 'history_replaced' && type !== 'turn_ended';
}

/** Select a shared contiguous body, retaining genuinely different display framing. */
function shared(value: string, base: string): { start: number; length: number; prefix: string; suffix: string } {
  const contained = base.indexOf(value);
  if (contained >= 0) return { start: contained, length: value.length, prefix: '', suffix: '' };
  const embedded = value.indexOf(base);
  if (embedded >= 0)
    return {
      start: 0,
      length: base.length,
      prefix: value.slice(0, embedded),
      suffix: value.slice(embedded + base.length),
    };
  const end = Math.min(value.length, base.length);
  let prefix = 0;
  while (prefix < end && value[prefix] === base[prefix]) prefix++;
  let suffix = 0;
  while (suffix < end && value[value.length - suffix - 1] === base[base.length - suffix - 1]) suffix++;
  const best =
    prefix >= suffix
      ? { start: 0, length: prefix, prefix: '', suffix: value.slice(prefix) }
      : { start: base.length - suffix, length: suffix, prefix: value.slice(0, value.length - suffix), suffix: '' };
  if (best.length >= MIN_SHARED) return best;
  // Different framing at BOTH ends (notably structured JSON versus display)
  // still shares a body. Fixed overlapping anchors find a common span without
  // a quadratic per-character diff table. Ordinary exact/prefix/suffix pairs
  // take the fast paths above.
  const anchor = MIN_SHARED / 2;
  for (let offset = 0; offset + anchor <= value.length; offset += anchor) {
    const probe = value.slice(offset, offset + anchor);
    let found = base.indexOf(probe);
    while (found >= 0) {
      let left = 0,
        right = anchor;
      while (left < offset && left < found && value[offset - left - 1] === base[found - left - 1]) left++;
      while (
        offset + right < value.length &&
        found + right < base.length &&
        value[offset + right] === base[found + right]
      )
        right++;
      if (left + right >= MIN_SHARED)
        return {
          start: found - left,
          length: left + right,
          prefix: value.slice(0, offset - left),
          suffix: value.slice(offset + right),
        };
      // Repeated anchors can align at the wrong occurrence (e.g. whitespace).
      // Do not conclude there is no shared body from the first match alone.
      found = base.indexOf(probe, found + 1);
    }
  }
  return best;
}

/** One codec per accepted lineage/writer; seed only with accepted hydrated entries. */
export class LogPayloads {
  readonly #entries = new Map<number, Fact>();
  readonly #candidates = new Map<string, Candidate[]>();

  constructor(entries: readonly FactLine[] = []) {
    for (const entry of entries) this.accept(entry.seq, entry.fact);
  }

  #add(candidates: Candidate[], source: Source, value: string): void {
    if (value.length < MIN_SHARED) return;
    const add = (source: Source, value: string): void => {
      if (value.length < MIN_SHARED) return;
      candidates.push({ source, value });
      // The same code/body also appears JSON-escaped inside rawArguments or
      // other provider JSON strings. Keep the earlier literal canonical without
      // normalizing the later provider string's whitespace or escape spelling.
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) candidates.push({ source: { ...source, jsonEscape: true }, value: escaped });
    };
    add(source, value);
    // Adopted structured outputs are JSON strings in tool_finished, but plain
    // strings inside the later provider_input. Reference the parsed body rather
    // than storing it again. JSON.parse does not alter the canonical output.
    if (!source.jsonPath) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      strings(parsed, (text, jsonPath) => {
        add({ ...source, jsonPath }, text);
      });
    }
  }

  /** Serialize a clone, leaving the caller and all accepted evidence untouched. */
  encode(seq: number, fact: Fact): { fact: Fact; refs?: readonly PayloadReference[] } {
    const physical = structuredClone(fact);
    const owner = turn(fact);
    if (!owner || !eligible(fact)) return { fact: physical };
    const candidates = [...(this.#candidates.get(owner) ?? [])];
    const refs: PayloadReference[] = [];
    strings(fact, (value, path) => {
      if (value.length < MIN_SHARED) return;
      let best: PayloadReference | undefined;
      let saved = Number.NEGATIVE_INFINITY;
      for (const candidate of candidates) {
        const part = shared(value, candidate.value);
        if (part.length < MIN_SHARED) continue;
        const ref = { path, source: candidate.source, ...part };
        const saving = JSON.stringify(value).length - JSON.stringify(ref).length;
        if (saving > saved) {
          best = ref;
          saved = saving;
        }
      }
      if (best) {
        refs.push(best);
        replace(physical, path, null);
      }
      this.#add(candidates, { seq, path }, value);
    });
    return { fact: physical, ...(refs.length ? { refs } : {}) };
  }

  /** Resolve references before schema validation. Malformed/forward/cross-turn
   * references are corruption, never a reason to drop output or continue. */
  decode(seq: number, fact: Fact, refs: unknown): Fact {
    if (refs === undefined) return fact;
    if (!Array.isArray(refs) || !eligible(fact) || !turn(fact)) throw new Error('invalid payload references');
    const path = (value: unknown): value is Path =>
      Array.isArray(value) &&
      value.every(
        (key) => typeof key === 'string' || (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0),
      );
    for (const raw of refs) {
      if (raw === null || typeof raw !== 'object') throw new Error('invalid payload reference');
      const ref = raw as PayloadReference;
      const source = ref.source;
      if (
        !path(ref.path) ||
        !source ||
        !path(source.path) ||
        (source.jsonPath !== undefined && !path(source.jsonPath)) ||
        (source.jsonEscape !== undefined && source.jsonEscape !== true) ||
        !Number.isSafeInteger(source.seq) ||
        source.seq > seq ||
        !Number.isSafeInteger(ref.start) ||
        ref.start < 0 ||
        !Number.isSafeInteger(ref.length) ||
        ref.length < 0 ||
        typeof ref.prefix !== 'string' ||
        typeof ref.suffix !== 'string'
      )
        throw new Error('invalid payload reference');
      const sourceFact = source.seq === seq ? fact : this.#entries.get(source.seq);
      if (!sourceFact || turn(sourceFact) !== turn(fact) || !eligible(sourceFact))
        throw new Error('payload reference is not accepted same-turn evidence');
      let body = at(sourceFact, source.path);
      if (source.jsonPath !== undefined) {
        if (typeof body !== 'string') throw new Error('payload JSON source is not a string');
        body = at(JSON.parse(body) as unknown, source.jsonPath);
      }
      if (typeof body !== 'string') throw new Error('invalid payload reference body');
      const text = source.jsonEscape ? JSON.stringify(body).slice(1, -1) : body;
      if (ref.start + ref.length > text.length || at(fact, ref.path) !== null)
        throw new Error('invalid payload reference body/target');
      replace(fact, ref.path, ref.prefix + text.slice(ref.start, ref.start + ref.length) + ref.suffix);
    }
    return fact;
  }

  /** Called only for complete accepted envelopes, including literal exceptions. */
  accept(seq: number, fact: Fact): void {
    this.#entries.set(seq, fact);
    const owner = turn(fact);
    if (!owner) return;
    const terminal = fact.type === 'branch_event' ? fact.fact.type : fact.type;
    if (terminal === 'turn_ended') {
      this.#candidates.delete(owner);
      return;
    }
    if (!eligible(fact)) return;
    const candidates = this.#candidates.get(owner) ?? [];
    strings(fact, (value, path) => this.#add(candidates, { seq, path }, value));
    this.#candidates.set(owner, candidates);
  }
}
