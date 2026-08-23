/** Application-owned headerless V4A diff implementation. */
export function applyDiff(input: string, diff: string, mode: 'default' | 'create' = 'default'): string {
  const lines = normalizeLines(diff);
  rejectEmbeddedFileEnvelope(lines);
  if (mode === 'create') return parseCreate(lines);
  return applyChunks(input, parseUpdate(lines, input).chunks);
}

const END_PATCH = '*** End Patch';
const END_FILE = '*** End of File';
const SECTION_MARKERS = [END_PATCH, '*** Update File:', '*** Delete File:', '*** Add File:', END_FILE];
const TERMINATORS = [END_PATCH, '*** Update File:', '*** Delete File:', '*** Add File:'];

function rejectEmbeddedFileEnvelope(lines: string[]): void {
  const header = lines.find((line) =>
    ['*** Update File:', '*** Delete File:', '*** Add File:'].some((prefix) => line.startsWith(prefix)),
  );
  if (!header) return;
  const marker = header.slice(0, header.indexOf(':') + 1);
  throw new Error(`Unsupported '${marker}' inside a single operation's diff. Use one entry in 'operations' per file.`);
}

type Parser = { lines: string[]; index: number; fuzz: number };
type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

function normalizeLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line, index, all) => !(index === all.length - 1 && line === ''));
}

function done(state: Parser, prefixes: string[]): boolean {
  return state.index >= state.lines.length || prefixes.some((prefix) => state.lines[state.index]?.startsWith(prefix));
}

function readPrefix(state: Parser, prefix: string): string {
  const line = state.lines[state.index];
  if (line?.startsWith(prefix)) {
    state.index += 1;
    return line.slice(prefix.length);
  }
  return '';
}

function parseCreate(lines: string[]): string {
  const parser: Parser = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 };
  const output: string[] = [];
  while (!done(parser, TERMINATORS)) {
    const line = parser.lines[parser.index++];
    if (!line.startsWith('+')) throw new Error(`Invalid Add File Line: ${line}`);
    output.push(line.slice(1));
  }
  return output.join('\n');
}

function parseUpdate(lines: string[], input: string): { chunks: Chunk[]; fuzz: number } {
  const parser: Parser = { lines: [...lines, END_PATCH], index: 0, fuzz: 0 };
  const inputLines = input.split('\n');
  const chunks: Chunk[] = [];
  let cursor = 0;
  while (!done(parser, SECTION_MARKERS)) {
    const anchor = readPrefix(parser, '@@ ');
    const bare = !anchor && parser.lines[parser.index] === '@@';
    if (bare) parser.index += 1;
    if (!anchor && !bare && cursor !== 0) throw new Error(`Invalid Line:\n${parser.lines[parser.index]}`);
    if (anchor.trim()) cursor = seekAnchor(anchor, inputLines, cursor, parser);
    const section = readSection(parser.lines, parser.index);
    const match = findContext(inputLines, section.context, cursor, section.eof);
    if (match.index === -1) {
      throw new Error(
        `${section.eof ? 'Invalid EOF Context' : 'Invalid Context'} ${cursor}:\n${section.context.join('\n')}`,
      );
    }
    parser.fuzz += match.fuzz;
    for (const chunk of section.chunks) chunks.push({ ...chunk, origIndex: chunk.origIndex + match.index });
    cursor = match.index + section.context.length;
    parser.index = section.endIndex;
  }
  return { chunks, fuzz: parser.fuzz };
}

function seekAnchor(anchor: string, lines: string[], cursor: number, parser: Parser): number {
  let found = false;
  if (!lines.slice(0, cursor).some((line) => line === anchor)) {
    for (let index = cursor; index < lines.length; index += 1) {
      if (lines[index] === anchor) {
        cursor = index + 1;
        found = true;
        break;
      }
    }
  }
  if (!found && !lines.slice(0, cursor).some((line) => line.trim() === anchor.trim())) {
    for (let index = cursor; index < lines.length; index += 1) {
      if (lines[index].trim() === anchor.trim()) {
        cursor = index + 1;
        parser.fuzz += 1;
        break;
      }
    }
  }
  return cursor;
}

function readSection(
  lines: string[],
  startIndex: number,
): {
  context: string[];
  chunks: Chunk[];
  endIndex: number;
  eof: boolean;
} {
  const context: string[] = [];
  const chunks: Chunk[] = [];
  let deletes: string[] = [];
  let inserts: string[] = [];
  let mode = 'keep';
  let index = startIndex;
  const originalIndex = index;
  while (index < lines.length) {
    const raw = lines[index];
    if (
      raw.startsWith('@@') ||
      raw.startsWith(END_PATCH) ||
      raw.startsWith('*** Update File:') ||
      raw.startsWith('*** Delete File:') ||
      raw.startsWith('*** Add File:') ||
      raw.startsWith(END_FILE)
    )
      break;
    if (raw === '***') break;
    if (raw.startsWith('***')) throw new Error(`Invalid Line: ${raw}`);
    index += 1;
    const previous = mode;
    let line = raw || ' ';
    if (line[0] === '+') mode = 'add';
    else if (line[0] === '-') mode = 'delete';
    else if (line[0] === ' ') mode = 'keep';
    else throw new Error(`Invalid Line: ${line}`);
    line = line.slice(1);
    if (mode === 'keep' && previous !== mode && (inserts.length || deletes.length)) {
      chunks.push({ origIndex: context.length - deletes.length, delLines: deletes, insLines: inserts });
      deletes = [];
      inserts = [];
    }
    if (mode === 'delete') {
      deletes.push(line);
      context.push(line);
    } else if (mode === 'add') inserts.push(line);
    else context.push(line);
  }
  if (inserts.length || deletes.length) {
    chunks.push({ origIndex: context.length - deletes.length, delLines: deletes, insLines: inserts });
  }
  if (index < lines.length && lines[index] === END_FILE) return { context, chunks, endIndex: index + 1, eof: true };
  if (index === originalIndex) throw new Error(`Nothing in this section - index=${index} ${lines[index]}`);
  return { context, chunks, endIndex: index, eof: false };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { index: number; fuzz: number } {
  if (eof) {
    const end = Math.max(0, lines.length - context.length);
    const exactEnd = findContextCore(lines, context, end, (line) => line);
    if (exactEnd.index !== -1) return exactEnd;
    const fallback = findContextCore(lines, context, start, (line) => line);
    return { index: fallback.index, fuzz: fallback.fuzz + 10000 };
  }
  return findContextCore(lines, context, start, (line) => line);
}

function findContextCore(
  lines: string[],
  context: string[],
  start: number,
  map: (line: string) => string,
): { index: number; fuzz: number } {
  if (!context.length) return { index: start, fuzz: 0 };
  for (let index = start; index < lines.length; index += 1)
    if (equalsSlice(lines, context, index, map)) return { index, fuzz: 0 };
  for (let index = start; index < lines.length; index += 1)
    if (equalsSlice(lines, context, index, (line) => map(line).trimEnd())) return { index, fuzz: 1 };
  for (let index = start; index < lines.length; index += 1)
    if (equalsSlice(lines, context, index, (line) => map(line).trim())) return { index, fuzz: 100 };
  return { index: -1, fuzz: 0 };
}

function equalsSlice(lines: string[], context: string[], start: number, map: (line: string) => string): boolean {
  if (start + context.length > lines.length) return false;
  return context.every((line, offset) => map(lines[start + offset]) === map(line));
}

function applyChunks(input: string, chunks: Chunk[]): string {
  const original = input.split('\n');
  const destination: string[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.origIndex > original.length)
      throw new Error(`applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${original.length}`);
    if (cursor > chunk.origIndex)
      throw new Error(`applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${cursor})`);
    destination.push(...original.slice(cursor, chunk.origIndex));
    cursor = chunk.origIndex;
    destination.push(...chunk.insLines);
    cursor += chunk.delLines.length;
  }
  destination.push(...original.slice(cursor));
  return destination.join('\n');
}
