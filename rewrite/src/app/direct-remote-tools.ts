import { AsyncLocalStorage } from 'node:async_hooks';
import { posix } from 'node:path';
import type { ISSHService, SSHCommandOptions, SSHCommandResult } from '../../../source/services/service-interfaces.js';
import { quoteShellArg } from '../../../source/services/ssh-service.js';
import type { Workspace } from '../tools/index.js';

type Scope = { readonly access: 'read' | 'write' | 'shell' | 'none'; readonly signal: AbortSignal };
const READERS = new Set(['read_file', 'grep', 'glob', 'run_code']);
const WRITERS = new Set(['create_file', 'search_replace', 'apply_patch']);
/** These source leaves use local fs/index/worktree facilities, not SSH. */
const LOCAL_ONLY = new Set([
  'read_code_outline',
  'code_context_search',
  'enter_worktree',
  'exit_worktree',
  'activate_skill',
]);

/**
 * A live remote transport bound to one authorized workspace. The integration
 * owner must run BOTH policy and execution callbacks (including scripted
 * physical leaves) through runTool using the ACTUAL source definition name.
 * A source reader may issue its own trusted search/canonicalization commands;
 * this is not command-string classification and is not a remote sandbox.
 * Path checks below are lexical scope checks, not a symlink-safe remote jail;
 * authorizers requiring hard filesystem isolation must reject this adapter.
 */
export class DirectRemoteTools implements ISSHService {
  readonly #service: ISSHService;
  readonly #workspace: Workspace;
  readonly #allowUnconfinedShell: boolean;
  readonly #scope = new AsyncLocalStorage<Scope>();
  #closed = false;

  constructor(options: {
    readonly service: ISSHService;
    readonly workspace: Workspace;
    readonly allowUnconfinedShell: boolean;
  }) {
    this.#service = options.service;
    this.#workspace = Object.freeze({ ...options.workspace });
    this.#allowUnconfinedShell = options.allowUnconfinedShell;
  }

  /** Never reconnect implicitly or substitute a local transport. */
  async connect(): Promise<void> {
    this.#assertConnected();
  }

  /** Session/app calls only after its admitted tool/background work has drained. */
  async disconnect(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#service.disconnect();
  }

  isConnected(): boolean {
    return !this.#closed && this.#service.isConnected();
  }

  /**
   * Bind a trusted leaf identity and its invocation cancellation, not model-
   * supplied permission flags. run_code gets read scope for its source authority
   * canonicalizer only; each physical child must replace that scope via this hook.
   */
  async runTool<T>(toolName: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    this.#assertConnected();
    signal.throwIfAborted();
    if (LOCAL_ONLY.has(toolName)) throw new Error(`${toolName} has no direct SSH implementation.`);
    const access = READERS.has(toolName)
      ? 'read'
      : WRITERS.has(toolName)
      ? 'write'
      : toolName === 'shell'
      ? 'shell'
      : 'none';
    if (access === 'write' && this.#workspace.access === 'read') throw new Error('Remote workspace is read-only.');
    if (access === 'shell' && (this.#workspace.access === 'read' || !this.#allowUnconfinedShell)) {
      throw new Error('Remote shell requires explicit unconfined-shell authority; SSH provides no read-only sandbox.');
    }
    return this.#scope.run({ access, signal }, operation);
  }

  /** Commands remain remote, preserve caller bounds, and retain typed SSH failures. */
  async executeCommand(command: string, options: SSHCommandOptions = {}): Promise<SSHCommandResult> {
    const scope = this.#active();
    const cwd = options.cwd === undefined ? this.#workspace.root : this.#path(options.cwd);
    const signal =
      options.signal && options.signal !== scope.signal
        ? AbortSignal.any([scope.signal, options.signal])
        : scope.signal;
    signal.throwIfAborted();
    return this.#service.executeCommand(command, { ...options, cwd, signal });
  }

  /** Text-file transport, matching ISSHService. Binary/media needs a separate byte API. */
  async readFile(path: string): Promise<string> {
    const result = await this.executeCommand(`cat -- ${quoteShellArg(this.#path(path))}`);
    requireExit(result, 'read remote file');
    return result.stdout;
  }

  /** printf preserves the exact text, including absent/final newlines; no heredoc delimiter. */
  async writeFile(path: string, content: string): Promise<void> {
    this.#writeAllowed();
    if (content.includes('\0')) throw new Error('SSH text-file writes cannot contain NUL bytes.');
    const result = await this.executeCommand(
      `printf '%s' ${quoteShellArg(content)} > ${quoteShellArg(this.#path(path))}`,
    );
    requireExit(result, 'write remote file');
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.#writeAllowed();
    const result = await this.executeCommand(
      `mkdir ${options?.recursive ? '-p ' : ''}-- ${quoteShellArg(this.#path(path))}`,
    );
    requireExit(result, 'create remote directory');
  }

  #writeAllowed(): void {
    const scope = this.#active();
    if (this.#workspace.access !== 'read_write' || (scope.access !== 'write' && scope.access !== 'shell')) {
      throw new Error('No remote filesystem-write authority for this invocation.');
    }
  }

  #active(): Scope {
    this.#assertConnected();
    const scope = this.#scope.getStore();
    if (!scope || scope.access === 'none') throw new Error('Direct remote tool invocation scope is unavailable.');
    scope.signal.throwIfAborted();
    return scope;
  }

  #path(value: string): string {
    if (!value || value.includes('\0')) throw new Error('Invalid remote path.');
    const resolved = posix.resolve(this.#workspace.root, value);
    const relative = posix.relative(this.#workspace.root, resolved);
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      throw new Error('Remote path exceeds the authorized workspace root.');
    }
    return resolved;
  }

  #assertConnected(): void {
    if (!this.isConnected())
      throw new Error('Direct SSH service is unavailable or disconnected; local fallback is forbidden.');
  }
}

function requireExit(result: SSHCommandResult, operation: string): void {
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(`Cannot ${operation}: ${result.stderr || `exit ${result.exitCode}`}`);
}
