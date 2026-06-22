import fs from 'node:fs';
import path from 'node:path';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { DeniedReadInfo } from './denied-read-detector.js';

/**
 * Per-callId execution override set at approval time and consumed by `execute` on resume.
 * - `extraAllowRead`: merged into allowRead for this one execution only.
 * - `forceUnsandboxed`: run this one call without the sandbox (approved escape).
 */
export interface ExecutionOverride {
  extraAllowRead?: string[];
  forceUnsandboxed?: boolean;
}

/**
 * In-memory, session-scoped store of denied-read info keyed by normalized command string.
 *
 * Lifecycle of an entry:
 * 1. `execute` detects a denied read → `record(command, info)`.
 * 2. The agent retries the same command; `needsApproval` calls `consume(command)` → returns the info
 *    (so the approval gate fires), then `stageForDescriptor(callId, info)` re-stages it so the
 *    approval-result builder can attach `deniedRead` metadata to the ApprovalDescriptor.
 * 3. `consumeStaged(callId)` is called by the result builder to attach and clear.
 */
export class DeniedReadStore {
  #byCommand = new Map<string, DeniedReadInfo>();
  #stagedByCallId = new Map<string, DeniedReadInfo>();

  record(command: string, info: DeniedReadInfo): void {
    this.#byCommand.set(command, info);
  }

  consume(command: string): DeniedReadInfo | null {
    const info = this.#byCommand.get(command);
    if (info) {
      this.#byCommand.delete(command);
      return info;
    }
    return null;
  }

  peek(command: string): DeniedReadInfo | null {
    return this.#byCommand.get(command) ?? null;
  }

  has(command: string): boolean {
    return this.#byCommand.has(command);
  }

  stageForDescriptor(callId: string, info: DeniedReadInfo): void {
    this.#stagedByCallId.set(callId, info);
  }

  consumeStaged(callId: string): DeniedReadInfo | null {
    const info = this.#stagedByCallId.get(callId);
    if (info) {
      this.#stagedByCallId.delete(callId);
      return info;
    }
    return null;
  }

  clear(): void {
    this.#byCommand.clear();
    this.#stagedByCallId.clear();
  }
}

/**
 * In-memory, per-callId store of execution overrides. Set at approval-decision time;
 * consumed and cleared by `execute` when the SDK resumes the approved tool call.
 */
export class ExecutionOverrideStore {
  #byCallId = new Map<string, ExecutionOverride>();

  set(callId: string, override: ExecutionOverride): void {
    this.#byCallId.set(callId, override);
  }

  consume(callId: string): ExecutionOverride | null {
    const override = this.#byCallId.get(callId);
    if (override) {
      this.#byCallId.delete(callId);
      return override;
    }
    return null;
  }

  clear(): void {
    this.#byCallId.clear();
  }
}

const PROJECT_CONFIG_DIR = '.term2';
const PROJECT_CONFIG_FILE = 'sandbox-allow-paths.json';

interface ProjectAllowPathsFile {
  version: number;
  allowReadExtra: string[];
}

/**
 * Persistent, project-scoped store of remembered allow-read paths.
 * Stored at `<workspaceRoot>/.term2/sandbox-allow-paths.json`.
 *
 * Paths are realpath-normalized and deduplicated before persistence.
 * A separate, dedicated store (not the global settings system) so that remembered
 * paths stay scoped to the workspace where they were approved.
 */
export class ProjectSandboxAllowReadStore {
  readonly #workspaceRoot: string;
  readonly #log?: ILoggingService;
  readonly #fs: typeof fs;

  constructor(workspaceRoot: string, fsImpl?: typeof fs, log?: ILoggingService) {
    this.#workspaceRoot = workspaceRoot;
    this.#fs = fsImpl ?? fs;
    this.#log = log;
  }

  get #configPath(): string {
    return path.join(this.#workspaceRoot, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  }

  load(): string[] {
    try {
      if (!this.#fs.existsSync(this.#configPath)) return [];
      const raw = this.#fs.readFileSync(this.#configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectAllowPathsFile>;
      if (!parsed || !Array.isArray(parsed.allowReadExtra)) return [];
      return this.#normalize(parsed.allowReadExtra);
    } catch (error) {
      // Corrupt or unreadable config: fail safe with an empty list.
      this.#log?.warn('Failed to read project sandbox-allow-paths; returning empty list', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  append(filePath: string): void {
    const normalized = this.#normalizeOne(filePath);
    const current = this.load();
    if (current.includes(normalized)) return;
    const next = [...current, normalized];
    this.#write(next);
  }

  #write(paths: string[]): void {
    const dir = path.dirname(this.#configPath);
    this.#fs.mkdirSync(dir, { recursive: true });
    const payload: ProjectAllowPathsFile = { version: 1, allowReadExtra: paths };
    this.#fs.writeFileSync(this.#configPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }

  #normalize(paths: string[]): string[] {
    return Array.from(new Set(paths.map((p) => this.#normalizeOne(p))));
  }

  #normalizeOne(filePath: string): string {
    try {
      return this.#fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }
}

/**
 * Module-level singletons shared between the shell tool and the approval flow.
 * A conversation is single-threaded in this CLI, so entries are consumed in order.
 * Each entry is one-shot (consumed on use), so no cross-turn contamination occurs.
 */
export const deniedReadStore = new DeniedReadStore();
export const executionOverrideStore = new ExecutionOverrideStore();

let projectAllowReadStore: ProjectSandboxAllowReadStore | null = null;
let projectAllowReadStoreRoot: string | null = null;

/**
 * Returns the project-scoped allow-read store for the given workspace root.
 * The store is lazily created and re-created if the workspace root changes
n * (unlikely in practice — the launch cwd is stable for the process).
 */
export function getProjectAllowReadStore(workspaceRoot: string): ProjectSandboxAllowReadStore {
  if (!projectAllowReadStore || projectAllowReadStoreRoot !== workspaceRoot) {
    projectAllowReadStore = new ProjectSandboxAllowReadStore(workspaceRoot);
    projectAllowReadStoreRoot = workspaceRoot;
  }
  return projectAllowReadStore;
}

/**
 * Test-only: reset all module-level singletons. Not for production use.
 */
export function resetSandboxDeniedReadStoresForTest(): void {
  deniedReadStore.clear();
  executionOverrideStore.clear();
  projectAllowReadStore = null;
  projectAllowReadStoreRoot = null;
}
