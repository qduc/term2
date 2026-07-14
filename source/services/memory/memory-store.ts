import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export type MemoryId = string;
export interface MemoryMetadata {
  id: MemoryId;
  title: string;
  summary: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
export interface Memory extends MemoryMetadata {
  content: string;
}
export interface CreateMemoryInput {
  id: MemoryId;
  title: string;
  summary: string;
  content: string;
  tags?: string[];
}
export interface UpdateMemoryInput {
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
}
export interface MemorySearchResult {
  memory: MemoryMetadata;
  matchedFields: Array<'id' | 'title' | 'summary' | 'tags' | 'content'>;
  available: boolean;
}
export interface MemoryStore {
  list(options?: { limit?: number }): Promise<MemoryMetadata[]>;
  get(id: MemoryId): Promise<Memory | null>;
  search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]>;
  create(input: CreateMemoryInput): Promise<Memory>;
  update(id: MemoryId, input: UpdateMemoryInput): Promise<Memory>;
  remove(id: MemoryId): Promise<boolean>;
}

export class InvalidMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMemoryError';
  }
}
export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = 'MemoryNotFoundError';
  }
}
export class MemoryAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`Memory already exists: ${id}`);
    this.name = 'MemoryAlreadyExistsError';
  }
}
export class MemoryStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryStorageError';
  }
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUMMARY_LIMIT = 300;
const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_READ_CONCURRENCY = 8;
type Index = { version: 1; memories: MemoryMetadata[] };
const mutationQueues = new Map<string, Promise<void>>();
const initializationPromises = new Map<string, Promise<void>>();

export class FileMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly indexBackupPath: string;
  private readonly itemsPath: string;
  private readonly now: () => Date;
  private readonly searchDefaultLimit: number;
  private readonly searchMaxLimit: number;

  constructor({
    root,
    now = () => new Date(),
    searchDefaultLimit = DEFAULT_SEARCH_LIMIT,
    searchMaxLimit = 50,
  }: {
    root: string;
    now?: () => Date;
    searchDefaultLimit?: number;
    searchMaxLimit?: number;
  }) {
    this.root = resolve(root);
    this.indexPath = join(this.root, 'index.json');
    this.indexBackupPath = join(this.root, 'index.backup.json');
    this.itemsPath = join(this.root, 'items');
    this.now = now;
    this.searchDefaultLimit = searchDefaultLimit;
    this.searchMaxLimit = searchMaxLimit;
  }

  async list(options: { limit?: number } = {}): Promise<MemoryMetadata[]> {
    const index = await this.load();
    return [...index.memories].sort(byRecent).slice(0, limit(options.limit, 50));
  }
  async get(id: MemoryId): Promise<Memory | null> {
    validateId(id);
    const metadata = (await this.load()).memories.find((memory) => memory.id === id);
    if (!metadata) return null;
    try {
      return { ...metadata, content: await readFile(this.itemPath(id), 'utf8') };
    } catch (_) {
      throw new MemoryStorageError(`Memory content is unavailable for '${id}'.`);
    }
  }
  async search(query: string, options: { limit?: number } = {}): Promise<MemorySearchResult[]> {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new InvalidMemoryError('Search query must not be empty.');
    const memories = [...(await this.load()).memories].sort(byRecent);
    const scored = await mapConcurrent(memories, SEARCH_READ_CONCURRENCY, async (memory) => {
      let score = 0;
      const fields = new Set<MemorySearchResult['matchedFields'][number]>();
      let content = '';
      let available = true;
      try {
        content = await readFile(this.itemPath(memory.id), 'utf8');
      } catch {
        available = false;
      }
      for (const term of terms) {
        if (memory.id === term) {
          score += 100;
          fields.add('id');
        } else if (memory.id.includes(term)) {
          score += 20;
          fields.add('id');
        }
        if (memory.title.toLowerCase().includes(term)) {
          score += 15;
          fields.add('title');
        }
        if (memory.tags.some((tag) => tag === term)) {
          score += 12;
          fields.add('tags');
        } else if (memory.tags.some((tag) => tag.includes(term))) {
          score += 12;
          fields.add('tags');
        }
        if (memory.summary.toLowerCase().includes(term)) {
          score += 8;
          fields.add('summary');
        }
        if (content.toLowerCase().includes(term)) {
          score += 2;
          fields.add('content');
        }
      }
      return { memory, matchedFields: [...fields], score, available };
    });
    return scored
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || byRecent(a.memory, b.memory))
      .slice(0, limit(options.limit, this.searchMaxLimit, this.searchDefaultLimit))
      .map(({ memory, matchedFields, available }) => ({ memory, matchedFields, available }));
  }
  async create(input: CreateMemoryInput): Promise<Memory> {
    return this.mutate(async () => {
      const normalized = normalizeCreate(input);
      const index = await this.load();
      if (index.memories.some((memory) => memory.id === normalized.id))
        throw new MemoryAlreadyExistsError(normalized.id);
      const timestamp = this.now().toISOString();
      const memory = { ...normalized, createdAt: timestamp, updatedAt: timestamp };
      await writeFile(this.itemPath(memory.id), memory.content, 'utf8');
      await this.writeIndex({ version: 1, memories: [...index.memories, metadata(memory)] });
      return memory;
    });
  }
  async update(id: MemoryId, input: UpdateMemoryInput): Promise<Memory> {
    if (!Object.values(input).some((value) => value !== undefined))
      throw new InvalidMemoryError('At least one field must be provided for a memory update.');
    return this.mutate(async () => {
      validateId(id);
      const index = await this.load();
      const existing = index.memories.find((entry) => entry.id === id);
      if (!existing) throw new MemoryNotFoundError(id);
      const old = await this.get(id);
      if (!old) throw new MemoryNotFoundError(id);
      const next = normalizeUpdate(old, input);
      const memory = { ...next, updatedAt: this.now().toISOString() };
      if (input.content !== undefined && input.content !== old.content)
        await writeFile(this.itemPath(id), memory.content, 'utf8');
      await this.writeIndex({
        version: 1,
        memories: index.memories.map((entry) => (entry.id === id ? metadata(memory) : entry)),
      });
      return memory;
    });
  }
  async remove(id: MemoryId): Promise<boolean> {
    return this.mutate(async () => {
      validateId(id);
      const index = await this.load();
      if (!index.memories.some((entry) => entry.id === id)) return false;
      await this.writeIndex({ version: 1, memories: index.memories.filter((entry) => entry.id !== id) });
      await unlink(this.itemPath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw new MemoryStorageError('Unable to remove memory content.');
      });
      return true;
    });
  }
  async context(budgetChars: number): Promise<string> {
    const header =
      '## Persistent memory\n\nThe following memories are summaries from previous sessions. Load full memories selectively with memory_get.\n\n';
    const note = 'Additional memories are available through `memory_list` and `memory_search`.';
    let output = header;
    let omitted = false;
    for (const memory of [...(await this.load()).memories].sort(byRecent)) {
      const entry = `- \`${memory.id}\` — ${memory.summary}\n`;
      if (output.length + entry.length + note.length > budgetChars) {
        omitted = true;
        continue;
      }
      output += entry;
    }
    return output === header ? '' : `${output}${omitted ? `\n${note}` : ''}`;
  }
  contextSync(budgetChars: number): string {
    let index: Index;
    try {
      index = validateIndex(JSON.parse(readFileSync(this.indexPath, 'utf8')));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return '';
      throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
    }
    const header =
      '## Persistent memory\n\nThe following memories are summaries from previous sessions. Load full memories selectively with memory_get.\n\n';
    const note = 'Additional memories are available through `memory_list` and `memory_search`.';
    let output = header;
    let omitted = false;
    for (const memory of [...index.memories].sort(byRecent)) {
      const entry = `- \`${memory.id}\` — ${memory.summary}\n`;
      if (output.length + entry.length + note.length > budgetChars) {
        omitted = true;
        continue;
      }
      output += entry;
    }
    return output === header ? '' : `${output}${omitted ? `\n${note}` : ''}`;
  }
  private itemPath(id: string) {
    validateId(id);
    return join(this.itemsPath, `${id}.md`);
  }
  private async load(): Promise<Index> {
    await this.initialize();
    let contents: string;
    try {
      contents = await readFile(this.indexPath, 'utf8');
    } catch {
      return this.recoverBackup();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return this.recoverBackup();
    }
    try {
      return validateIndex(parsed);
    } catch {
      throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
    }
  }
  private async initialize() {
    const existing = initializationPromises.get(this.root);
    if (existing) return existing;
    const initialization = this.initializeOnce();
    initializationPromises.set(this.root, initialization);
    try {
      await initialization;
    } finally {
      if (initializationPromises.get(this.root) === initialization) initializationPromises.delete(this.root);
    }
  }
  private async initializeOnce() {
    try {
      await mkdir(this.itemsPath, { recursive: true });
      await readFile(this.indexPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new MemoryStorageError('Unable to initialize memory storage.');
      try {
        await this.recoverBackup();
      } catch {
        await this.writeIndex({ version: 1, memories: [] });
      }
    }
  }
  private async recoverBackup(): Promise<Index> {
    try {
      const backup = validateIndex(JSON.parse(await readFile(this.indexBackupPath, 'utf8')));
      await this.writeFileAtomically(this.indexPath, serializeIndex(backup));
      return backup;
    } catch {
      throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
    }
  }
  private async writeIndex(index: Index) {
    try {
      const contents = serializeIndex(index);
      await this.writeFileAtomically(this.indexPath, contents);
      await this.writeFileAtomically(this.indexBackupPath, contents);
    } catch {
      throw new MemoryStorageError('Unable to save memory index.');
    }
  }
  private async writeFileAtomically(path: string, contents: string) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, path);
  }
  private async mutate<T>(operation: () => Promise<T>) {
    const queue = mutationQueues.get(this.root) ?? Promise.resolve();
    const result = queue.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(this.root, settled);
    settled.finally(() => {
      if (mutationQueues.get(this.root) === settled) mutationQueues.delete(this.root);
    });
    return result;
  }
}
function validateId(id: string) {
  if (typeof id !== 'string' || !ID.test(id))
    throw new InvalidMemoryError('Memory ID must contain lowercase letters, numbers, and single hyphens.');
}
function normalizeCreate(input: CreateMemoryInput) {
  validateId(input.id);
  return {
    ...input,
    title: required(input.title, 'Title'),
    summary: summary(input.summary),
    content: required(input.content, 'Content'),
    tags: tags(input.tags),
  };
}
function normalizeUpdate(old: Memory, input: UpdateMemoryInput): Memory {
  return {
    ...old,
    title: input.title === undefined ? old.title : required(input.title, 'Title'),
    summary: input.summary === undefined ? old.summary : summary(input.summary),
    content: input.content === undefined ? old.content : required(input.content, 'Content'),
    tags: input.tags === undefined ? old.tags : tags(input.tags),
  };
}
function required(value: string, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidMemoryError(`${field} must not be empty.`);
  return value.trim();
}
function summary(value: string) {
  const result = required(value, 'Summary');
  if (result.length > SUMMARY_LIMIT)
    throw new InvalidMemoryError(`Summary must not exceed ${SUMMARY_LIMIT} characters.`);
  return result;
}
function tags(value: string[] | undefined) {
  if (value !== undefined && (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')))
    throw new InvalidMemoryError('Tags must be strings.');
  return [...new Set((value ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}
function metadata(memory: Memory): MemoryMetadata {
  const { content: _, ...result } = memory;
  return result;
}
function byRecent(a: MemoryMetadata, b: MemoryMetadata) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}
function limit(value: number | undefined, max: number, fallback = max) {
  return Math.min(Math.max(1, value ?? fallback), max);
}
async function mapConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await operation(items[index]);
      }
    }),
  );
  return results;
}

function serializeIndex(index: Index): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function validateIndex(value: unknown): Index {
  const index = value as Index;
  if (!index || index.version !== 1 || !Array.isArray(index.memories))
    throw new MemoryStorageError('Memory index has an unsupported format.');
  const ids = new Set<string>();
  for (const entry of index.memories) {
    try {
      validateId(entry?.id);
      if (
        ids.has(entry.id) ||
        typeof entry.title !== 'string' ||
        !entry.title.trim() ||
        typeof entry.summary !== 'string' ||
        !entry.summary.trim() ||
        entry.summary.length > SUMMARY_LIMIT ||
        !Array.isArray(entry.tags) ||
        entry.tags.some((tag) => typeof tag !== 'string') ||
        !isUtcTimestamp(entry.createdAt) ||
        !isUtcTimestamp(entry.updatedAt)
      )
        throw new Error();
      ids.add(entry.id);
    } catch {
      throw new MemoryStorageError('Memory index contains invalid metadata.');
    }
  }
  return index;
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
