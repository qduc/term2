import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { queryTerms, scoreMemorySearch } from './memory-search.js';
export class InvalidMemoryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidMemoryError';
    }
}
export class MemoryNotFoundError extends Error {
    constructor(id) {
        super(`Memory not found: ${id}`);
        this.name = 'MemoryNotFoundError';
    }
}
export class MemoryAlreadyExistsError extends Error {
    constructor(id) {
        super(`Memory already exists: ${id}`);
        this.name = 'MemoryAlreadyExistsError';
    }
}
export class MemoryStorageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemoryStorageError';
    }
}
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Keep summaries bounded enough for the injected index, but do not reject
// useful handoff context merely because it exceeds the former 300-char limit.
const SUMMARY_LIMIT = 1_000;
const INDEX_HEADER = '## Persistent memory\n\n';
const INDEX_RETRIEVAL_HINT = 'Load full memories selectively with memory_get.';
// Rendered title cap: the full title stays in storage and tool results; only
// the injected index line is bounded.
const TITLE_RENDER_CAP = 120;
/**
 * Renders the injected memory index for one scope as two contiguous recency
 * prefixes: the newest `listed` memories get a title line, and the newest
 * `summarized` of those additionally carry their full summary. Length decides
 * where a prefix ends, never which items appear — an older entry is never
 * summarized after a newer one was excluded. Every degradation is counted in
 * the status line, and nothing is dropped silently: unlisted memories are
 * counted and pointed at the retrieval tools.
 */
function renderMemoryIndex(memories, budgetChars, options = {}) {
    if (!memories.length)
        return { text: '', total: 0, summarized: 0, titleOnly: 0, notListed: 0 };
    const sorted = [...memories].sort(byRecent);
    const total = sorted.length;
    const titleLines = sorted.map((memory) => `- \`${memory.id}\` — ${renderTitle(memory.title)}\n`);
    // Prefix sums make every (listed, summarized) candidate's length O(1): the
    // first `summarized` title lines grow by ' — ' + summary (their trailing
    // newline is replaced).
    const titlePrefix = [0];
    const summaryPrefix = [0];
    for (let index = 0; index < total; index += 1) {
        titlePrefix.push(titlePrefix[index] + titleLines[index].length);
        summaryPrefix.push(summaryPrefix[index] + SUMMARY_EXTENSION.length + sorted[index].summary.length);
    }
    const header = options.pinnedGlobal ? '### Global memories\n\n' : INDEX_HEADER;
    const hint = options.pinnedGlobal ? '' : ` ${INDEX_RETRIEVAL_HINT}`;
    const pointer = (count) => count > 0
        ? options.pinnedGlobal
            ? `+ ${count} more global memories exist; find them with memory_search.\n`
            : `+ ${count} not listed — memory_list or memory_search for the full index.\n`
        : '';
    for (let listed = total; listed >= 1; listed -= 1) {
        const notListed = total - listed;
        const pointerLine = pointer(notListed);
        for (let summarized = listed; summarized >= 0; summarized -= 1) {
            const titleOnly = listed - summarized;
            const status = `${total} memories · ${summarized} summarized · ${titleOnly} title-only · ${notListed} not listed.${hint}\n\n`;
            const divider = summarized > 0 && titleOnly > 0 ? INDEX_DIVIDER : '';
            const length = header.length +
                status.length +
                titlePrefix[listed] +
                summaryPrefix[summarized] +
                divider.length +
                pointerLine.length;
            if (length > budgetChars)
                continue;
            const body = titleLines
                .slice(0, listed)
                .map((line, index) => index < summarized ? `${line.slice(0, -1)}${SUMMARY_EXTENSION}${sorted[index].summary}\n` : line)
                .join('');
            return {
                text: `${header}${status}${body}${divider}${pointerLine}`,
                total,
                summarized,
                titleOnly,
                notListed,
            };
        }
    }
    // No entry fits. Show counted omissions only if even the floor fits.
    const notListed = total;
    const floor = `${header}${total} memories · 0 summarized · 0 title-only · ${notListed} not listed.${hint}\n\n${pointer(notListed)}`;
    return { text: floor.length <= budgetChars ? floor : '', total, summarized: 0, titleOnly: 0, notListed: total };
}
const SUMMARY_EXTENSION = ' — ';
const INDEX_DIVIDER = '— older entries, titles only —\n';
function renderTitle(title) {
    return title.length > TITLE_RENDER_CAP ? `${title.slice(0, TITLE_RENDER_CAP)}…` : title;
}
const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_READ_CONCURRENCY = 8;
const mutationQueues = new Map();
const initializationPromises = new Map();
export class FileMemoryStore {
    root;
    indexPath;
    indexBackupPath;
    itemsPath;
    now;
    searchDefaultLimit;
    searchMaxLimit;
    constructor({ root, now = () => new Date(), searchDefaultLimit = DEFAULT_SEARCH_LIMIT, searchMaxLimit = 50, }) {
        this.root = resolve(root);
        this.indexPath = join(this.root, 'index.json');
        this.indexBackupPath = join(this.root, 'index.backup.json');
        this.itemsPath = join(this.root, 'items');
        this.now = now;
        this.searchDefaultLimit = searchDefaultLimit;
        this.searchMaxLimit = searchMaxLimit;
    }
    async list(options = {}) {
        const index = await this.load();
        return [...index.memories].sort(byRecent).slice(0, limit(options.limit, 50));
    }
    async get(id) {
        validateId(id);
        const metadata = (await this.load()).memories.find((memory) => memory.id === id);
        if (!metadata)
            return null;
        try {
            return { ...metadata, content: await readFile(this.itemPath(id), 'utf8') };
        }
        catch (_) {
            throw new MemoryStorageError(`Memory content is unavailable for '${id}'.`);
        }
    }
    async history(id) {
        validateId(id);
        if (!(await this.load()).memories.some((entry) => entry.id === id))
            return [];
        try {
            const entries = JSON.parse(await readFile(this.historyPath(id), 'utf8'));
            if (!Array.isArray(entries) || !entries.every(validHistoryEntry))
                throw new Error();
            return entries;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw new MemoryStorageError(`Memory history is unavailable for '${id}'.`);
        }
    }
    async search(query, options = {}) {
        const terms = queryTerms(query);
        if (!terms.length)
            throw new InvalidMemoryError('Search query must not be empty.');
        const memories = [...(await this.load()).memories].sort(byRecent);
        const scored = await mapConcurrent(memories, SEARCH_READ_CONCURRENCY, async (memory) => {
            let content = '';
            let available = true;
            try {
                content = await readFile(this.itemPath(memory.id), 'utf8');
            }
            catch {
                available = false;
            }
            const { score, matchedFields } = scoreMemorySearch(memory, content, terms);
            return { memory, matchedFields, score, available, content: available ? content : undefined };
        });
        return scored
            .filter((result) => result.score > 0)
            .sort((a, b) => b.score - a.score || byRecent(a.memory, b.memory))
            .slice(0, limit(options.limit, this.searchMaxLimit, this.searchDefaultLimit))
            .map(({ memory, matchedFields, available, score, content }) => ({
            memory,
            matchedFields,
            available,
            score,
            content,
        }));
    }
    searchLimits() {
        return { defaultLimit: this.searchDefaultLimit, maxLimit: this.searchMaxLimit };
    }
    async create(input) {
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
    /** A non-blocking, cross-process pilot lock; a busy/stale lock fails closed. */
    async createAutomatic(input, sessionId) {
        return this.mutate(async () => {
            const normalized = normalizeCreate(input);
            if (!sessionId.trim())
                throw new InvalidMemoryError('Automatic memory requires a source session.');
            await this.initialize();
            const lock = join(this.root, '.automatic-canary.lock');
            try {
                await mkdir(lock);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    return null;
                throw error;
            }
            try {
                const index = await this.load();
                if (index.memories.some((memory) => memory.id === normalized.id || memory.title === normalized.title))
                    return null;
                const timestamp = this.now().toISOString();
                const memory = {
                    ...normalized,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    provenance: { at: timestamp, sessionId: sessionId.trim(), reason: normalized.content },
                };
                await writeFile(this.itemPath(memory.id), memory.content, { encoding: 'utf8', flag: 'wx' });
                try {
                    await this.writeIndex({ version: 1, memories: [...index.memories, metadata(memory)] });
                }
                catch (error) {
                    // The primary index may have committed before its backup failed.
                    // Only discard the item when a readable index proves it was not committed.
                    const committed = await this.load().then((current) => current.memories.some((entry) => entry.id === memory.id), () => true);
                    if (!committed)
                        await unlink(this.itemPath(memory.id));
                    throw error;
                }
                return memory;
            }
            finally {
                await rmdir(lock);
            }
        });
    }
    async update(id, input, context) {
        if (!Object.entries(input).some(([key, value]) => key !== 'supersede' && value !== undefined))
            throw new InvalidMemoryError('At least one field must be provided for a memory update.');
        if (input.supersede && !input.supersede.reason?.trim())
            throw new InvalidMemoryError('A correction requires a reason.');
        return this.mutate(async () => {
            validateId(id);
            const index = await this.load();
            const existing = index.memories.find((entry) => entry.id === id);
            if (!existing)
                throw new MemoryNotFoundError(id);
            const old = await this.get(id);
            if (!old)
                throw new MemoryNotFoundError(id);
            const next = normalizeUpdate(old, input);
            const timestamp = this.now().toISOString();
            const provenance = input.supersede && {
                at: timestamp,
                ...(context?.sessionId?.trim() ? { sessionId: context.sessionId.trim() } : {}),
                reason: input.supersede.reason.trim(),
            };
            const memory = { ...next, updatedAt: timestamp, ...(provenance ? { provenance } : {}) };
            if (provenance) {
                const history = await this.history(id);
                await this.writeFileAtomically(this.historyPath(id), `${JSON.stringify([...history, { ...old, supersededBy: provenance }], null, 2)}\n`);
            }
            if (input.content !== undefined && input.content !== old.content)
                await this.writeFileAtomically(this.itemPath(id), memory.content);
            await this.writeIndex({
                version: 1,
                memories: index.memories.map((entry) => (entry.id === id ? metadata(memory) : entry)),
            });
            return memory;
        });
    }
    async remove(id) {
        return this.mutate(async () => {
            validateId(id);
            const index = await this.load();
            if (!index.memories.some((entry) => entry.id === id))
                return false;
            await this.writeIndex({ version: 1, memories: index.memories.filter((entry) => entry.id !== id) });
            await unlink(this.itemPath(id)).catch((error) => {
                if (error.code !== 'ENOENT')
                    throw new MemoryStorageError('Unable to remove memory content.');
            });
            await unlink(this.historyPath(id)).catch((error) => {
                if (error.code !== 'ENOENT')
                    throw new MemoryStorageError('Unable to remove memory history.');
            });
            return true;
        });
    }
    async context(budgetChars, options) {
        return renderMemoryIndex([...(await this.load()).memories], budgetChars, options).text;
    }
    contextSync(budgetChars, options) {
        let index;
        try {
            index = validateIndex(JSON.parse(readFileSync(this.indexPath, 'utf8')));
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return '';
            throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
        }
        return renderMemoryIndex([...index.memories], budgetChars, options).text;
    }
    itemPath(id) {
        validateId(id);
        return join(this.itemsPath, `${id}.md`);
    }
    historyPath(id) {
        validateId(id);
        return join(this.itemsPath, `${id}.history.json`);
    }
    async load() {
        await this.initialize();
        let contents;
        try {
            contents = await readFile(this.indexPath, 'utf8');
        }
        catch {
            return this.recoverBackup();
        }
        let parsed;
        try {
            parsed = JSON.parse(contents);
        }
        catch {
            return this.recoverBackup();
        }
        try {
            return validateIndex(parsed);
        }
        catch {
            throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
        }
    }
    async initialize() {
        const existing = initializationPromises.get(this.root);
        if (existing)
            return existing;
        const initialization = this.initializeOnce();
        initializationPromises.set(this.root, initialization);
        try {
            await initialization;
        }
        finally {
            if (initializationPromises.get(this.root) === initialization)
                initializationPromises.delete(this.root);
        }
    }
    async initializeOnce() {
        try {
            await mkdir(this.itemsPath, { recursive: true });
            await readFile(this.indexPath, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw new MemoryStorageError('Unable to initialize memory storage.');
            try {
                await this.recoverBackup();
            }
            catch {
                await this.writeIndex({ version: 1, memories: [] });
            }
        }
    }
    async recoverBackup() {
        try {
            const backup = validateIndex(JSON.parse(await readFile(this.indexBackupPath, 'utf8')));
            await this.writeFileAtomically(this.indexPath, serializeIndex(backup));
            return backup;
        }
        catch {
            throw new MemoryStorageError('Memory index.json is corrupted or unreadable.');
        }
    }
    async writeIndex(index) {
        try {
            const contents = serializeIndex(index);
            await this.writeFileAtomically(this.indexPath, contents);
            await this.writeFileAtomically(this.indexBackupPath, contents);
        }
        catch {
            throw new MemoryStorageError('Unable to save memory index.');
        }
    }
    async writeFileAtomically(path, contents) {
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, 'utf8');
        await rename(temporary, path);
    }
    async mutate(operation) {
        const queue = mutationQueues.get(this.root) ?? Promise.resolve();
        const result = queue.then(operation, operation);
        const settled = result.then(() => undefined, () => undefined);
        mutationQueues.set(this.root, settled);
        settled.finally(() => {
            if (mutationQueues.get(this.root) === settled)
                mutationQueues.delete(this.root);
        });
        return result;
    }
}
function validateId(id) {
    if (typeof id !== 'string' || !ID.test(id))
        throw new InvalidMemoryError('Memory ID must contain lowercase letters, numbers, and single hyphens.');
}
function normalizeCreate(input) {
    validateId(input.id);
    return {
        ...input,
        title: required(input.title, 'Title'),
        summary: summary(input.summary),
        content: required(input.content, 'Content'),
        tags: tags(input.tags),
    };
}
function normalizeUpdate(old, input) {
    return {
        ...old,
        title: input.title === undefined ? old.title : required(input.title, 'Title'),
        summary: input.summary === undefined ? old.summary : summary(input.summary),
        content: input.content === undefined ? old.content : required(input.content, 'Content'),
        tags: input.tags === undefined ? old.tags : tags(input.tags),
    };
}
function required(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new InvalidMemoryError(`${field} must not be empty.`);
    return value.trim();
}
function summary(value) {
    const result = required(value, 'Summary');
    if (result.length > SUMMARY_LIMIT)
        throw new InvalidMemoryError(`Summary must not exceed ${SUMMARY_LIMIT} characters.`);
    return result;
}
function tags(value) {
    if (value !== undefined && (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')))
        throw new InvalidMemoryError('Tags must be strings.');
    return [...new Set((value ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}
function metadata(memory) {
    const { content: _, ...result } = memory;
    return result;
}
function byRecent(a, b) {
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}
function limit(value, max, fallback = max) {
    return Math.min(Math.max(1, value ?? fallback), max);
}
async function mapConcurrent(items, concurrency, operation) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await operation(items[index]);
        }
    }));
    return results;
}
function serializeIndex(index) {
    return `${JSON.stringify(index, null, 2)}\n`;
}
function validateIndex(value) {
    const index = value;
    if (!index || index.version !== 1 || !Array.isArray(index.memories))
        throw new MemoryStorageError('Memory index has an unsupported format.');
    const ids = new Set();
    for (const entry of index.memories) {
        try {
            validateId(entry?.id);
            if (ids.has(entry.id) ||
                typeof entry.title !== 'string' ||
                !entry.title.trim() ||
                typeof entry.summary !== 'string' ||
                !entry.summary.trim() ||
                entry.summary.length > SUMMARY_LIMIT ||
                !Array.isArray(entry.tags) ||
                entry.tags.some((tag) => typeof tag !== 'string') ||
                !isUtcTimestamp(entry.createdAt) ||
                !isUtcTimestamp(entry.updatedAt) ||
                (entry.provenance !== undefined && !validProvenance(entry.provenance)))
                throw new Error();
            ids.add(entry.id);
        }
        catch {
            throw new MemoryStorageError('Memory index contains invalid metadata.');
        }
    }
    return index;
}
function validProvenance(value) {
    const provenance = value;
    return (!!provenance &&
        isUtcTimestamp(provenance.at) &&
        (provenance.sessionId === undefined ||
            (typeof provenance.sessionId === 'string' && !!provenance.sessionId.trim())) &&
        typeof provenance.reason === 'string' &&
        !!provenance.reason.trim());
}
function validHistoryEntry(value) {
    const entry = value;
    if (!entry || typeof entry.content !== 'string' || !validProvenance(entry.supersededBy))
        return false;
    try {
        validateIndex({ version: 1, memories: [metadata(entry)] });
        return true;
    }
    catch {
        return false;
    }
}
function isUtcTimestamp(value) {
    return (typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        !Number.isNaN(Date.parse(value)));
}
//# sourceMappingURL=memory-store.js.map