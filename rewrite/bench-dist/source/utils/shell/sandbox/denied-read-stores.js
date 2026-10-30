import fs from 'node:fs';
import path from 'node:path';
/**
 * In-memory, session-scoped store of denied-read info keyed by normalized command string.
 *
 * Lifecycle of an entry:
 * 1. `execute` detects a denied read → `record(command, info)`.
 * 2. The agent retries the same command; the approval-result builder calls `consume(command)` → returns the info
 *    (so the approval gate fires), then `stageForDescriptor(command, info)` re-stages it so the
 *    approval-result builder can attach `deniedRead` metadata to the ApprovalDescriptor.
 * 3. `consumeStaged(command)` is called by the approval flow to set the retry override and clear.
 */
export class DeniedReadStore {
    #byCommand = new Map();
    #stagedByDescriptorKey = new Map();
    record(command, info) {
        this.#byCommand.set(command, info);
    }
    consume(command) {
        const info = this.#byCommand.get(command);
        if (info) {
            this.#byCommand.delete(command);
            return info;
        }
        return null;
    }
    peek(command) {
        return this.#byCommand.get(command) ?? null;
    }
    has(command) {
        return this.#byCommand.has(command);
    }
    stageForDescriptor(descriptorKey, info) {
        this.#stagedByDescriptorKey.set(descriptorKey, info);
    }
    consumeStaged(descriptorKey) {
        const info = this.#stagedByDescriptorKey.get(descriptorKey);
        if (info) {
            this.#stagedByDescriptorKey.delete(descriptorKey);
            return info;
        }
        return null;
    }
    clear() {
        this.#byCommand.clear();
        this.#stagedByDescriptorKey.clear();
    }
}
/**
 * In-memory, per-command store of execution overrides. Set at approval-decision time;
 * consumed and cleared by `execute` when the SDK resumes the approved tool call.
 */
export class ExecutionOverrideStore {
    #byCommand = new Map();
    set(command, override) {
        this.#byCommand.set(command, override);
    }
    consume(command) {
        const override = this.#byCommand.get(command);
        if (override) {
            this.#byCommand.delete(command);
            return override;
        }
        return null;
    }
    clear() {
        this.#byCommand.clear();
    }
}
const PROJECT_CONFIG_DIR = '.term2';
const PROJECT_CONFIG_FILE = 'sandbox-allow-paths.json';
/**
 * Persistent, project-scoped store of remembered allow-read paths.
 * Stored at `<workspaceRoot>/.term2/sandbox-allow-paths.json`.
 *
 * Paths are realpath-normalized and deduplicated before persistence.
 * A separate, dedicated store (not the global settings system) so that remembered
 * paths stay scoped to the workspace where they were approved.
 */
export class ProjectSandboxAllowReadStore {
    #workspaceRoot;
    #log;
    #fs;
    constructor(workspaceRoot, fsImpl, log) {
        this.#workspaceRoot = workspaceRoot;
        this.#fs = fsImpl ?? fs;
        this.#log = log;
    }
    get #configPath() {
        return path.join(this.#workspaceRoot, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
    }
    load() {
        try {
            if (!this.#fs.existsSync(this.#configPath))
                return [];
            const raw = this.#fs.readFileSync(this.#configPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.allowReadExtra))
                return [];
            return this.#normalize(parsed.allowReadExtra);
        }
        catch (error) {
            // Corrupt or unreadable config: fail safe with an empty list.
            this.#log?.warn('Failed to read project sandbox-allow-paths; returning empty list', {
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    }
    append(filePath) {
        const normalized = this.#normalizeOne(filePath);
        const current = this.load();
        if (current.includes(normalized))
            return;
        const next = [...current, normalized];
        this.#write(next);
    }
    #write(paths) {
        const dir = path.dirname(this.#configPath);
        this.#fs.mkdirSync(dir, { recursive: true });
        const payload = { version: 1, allowReadExtra: paths };
        this.#fs.writeFileSync(this.#configPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }
    #normalize(paths) {
        return Array.from(new Set(paths.map((p) => this.#normalizeOne(p))));
    }
    #normalizeOne(filePath) {
        try {
            return this.#fs.realpathSync(filePath);
        }
        catch {
            return path.resolve(filePath);
        }
    }
}
/** Module-level compatibility singletons shared by nested tools and approval flow. */
export const deniedReadStore = new DeniedReadStore();
export const executionOverrideStore = new ExecutionOverrideStore();
let projectAllowReadStore = null;
let projectAllowReadStoreRoot = null;
/**
 * Returns the project-scoped allow-read store for the given workspace root.
 * The store is lazily created and re-created if the workspace root changes
 * (unlikely in practice — the launch cwd is stable for the process).
 */
export function getProjectAllowReadStore(workspaceRoot) {
    if (!projectAllowReadStore || projectAllowReadStoreRoot !== workspaceRoot) {
        projectAllowReadStore = new ProjectSandboxAllowReadStore(workspaceRoot);
        projectAllowReadStoreRoot = workspaceRoot;
    }
    return projectAllowReadStore;
}
export function resetSandboxDeniedReadStoresForTest() {
    deniedReadStore.clear();
    executionOverrideStore.clear();
    projectAllowReadStore = null;
    projectAllowReadStoreRoot = null;
}
//# sourceMappingURL=denied-read-stores.js.map