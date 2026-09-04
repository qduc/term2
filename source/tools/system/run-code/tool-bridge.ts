import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensureSandboxTempDir } from '../../../utils/shell/temp-dir.js';
import { normalizeToolParameters } from '../../../lib/tool-invoke.js';
import { isZodToolParameterSchema, type AnyToolDefinition, type ToolRegistry } from '../../types.js';

/** One `tools.*` call observed by the bridge, for the user-facing summary. */
export interface ToolBridgeCallRecord {
  tool: string;
  outcome: 'ok' | 'error' | 'approval_required' | 'unknown_tool' | 'invalid_params';
  durationMs: number;
}

export interface ToolBridgeLimits {
  /** Total `tools.*` calls one script may make before the bridge refuses more. */
  maxCalls: number;
  /** Per-result cap. A larger result is truncated with an explicit marker. */
  maxResultChars: number;
  /**
   * Cap on a single unterminated request frame. Without it a script could make
   * the host buffer unbounded bytes before the first newline arrives.
   */
  maxRequestBytes: number;
}

export const DEFAULT_TOOL_BRIDGE_LIMITS: ToolBridgeLimits = {
  maxCalls: 200,
  maxResultChars: 100_000,
  maxRequestBytes: 4_000_000,
};

export interface ToolBridgeOptions {
  /** The tools to expose. This is the agent's own live registry. */
  registry: ToolRegistry;
  /** Context forwarded verbatim to each tool's `needsApproval`/`execute`. */
  toolContext?: unknown;
  limits?: Partial<ToolBridgeLimits>;
  onCall?: (record: ToolBridgeCallRecord) => void;
}

interface BridgeRequest {
  id?: unknown;
  tool?: unknown;
  params?: unknown;
}

/**
 * Truncation is a display concern, but a script may branch on the result, so the
 * marker has to be unmistakable rather than a silent cut.
 */
const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated: result exceeded ${limit} characters]`;

const serializeResult = (result: unknown, limit: number): unknown => {
  if (typeof result === 'string') return truncate(result, limit);
  try {
    const encoded = JSON.stringify(result);
    if (encoded === undefined) return null;
    return encoded.length <= limit ? result : truncate(encoded, limit);
  } catch {
    return truncate(String(result), limit);
  }
};

/**
 * A Unix-socket JSON-RPC endpoint that lets code running inside the shell
 * sandbox re-enter the host's real tool implementations.
 *
 * The socket is the only channel out of the sandbox, so this class is the whole
 * trust boundary: every request is matched to a registered tool, normalized
 * against that tool's schema, and run through its own `needsApproval` before it
 * can execute. Nothing here can approve a call — approval prompts belong to the
 * run loop, which is not on the stack during a tool execution — so a call that
 * needs approval is refused and the script is told why.
 */
export class ToolBridgeServer {
  readonly #registry: ToolRegistry;
  readonly #toolContext: unknown;
  readonly #limits: ToolBridgeLimits;
  readonly #onCall?: (record: ToolBridgeCallRecord) => void;
  readonly #sockets = new Set<net.Socket>();
  #server: net.Server | undefined;
  #socketPath: string | undefined;
  #callCount = 0;
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: ToolBridgeOptions) {
    this.#registry = options.registry;
    this.#toolContext = options.toolContext;
    this.#limits = { ...DEFAULT_TOOL_BRIDGE_LIMITS, ...options.limits };
    this.#onCall = options.onCall;
  }

  get socketPath(): string {
    if (!this.#socketPath) throw new Error('Tool bridge has not been started');
    return this.#socketPath;
  }

  get callCount(): number {
    return this.#callCount;
  }

  /** Names exposed to the script, in registry order. */
  toolNames(): string[] {
    return this.#registry.map((tool) => tool.name);
  }

  async start(): Promise<string> {
    const tempDir = ensureSandboxTempDir();
    // Unix socket paths are capped near 104 bytes on macOS, so keep the name short.
    const socketPath = path.join(tempDir, `t2-tools-${randomUUID().slice(0, 8)}.sock`);
    const server = net.createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => this.#sockets.delete(socket));
      this.#attach(socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.#server = server;
    this.#socketPath = socketPath;
    return socketPath;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // Destroying the client socket does not cancel a host tool already running.
    // Waiting for the queue keeps a finished run from reporting its result while
    // one of its own tool calls is still mutating the workspace.
    await this.#queue.catch(() => {});
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.#socketPath) {
      // The socket file lives in the shared sandbox temp dir; leaving it behind
      // would accumulate dead entries across runs.
      await unlink(this.#socketPath).catch(() => {});
      this.#socketPath = undefined;
    }
  }

  #attach(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.#handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > this.#limits.maxRequestBytes) {
        // The peer is mid-frame and already over budget. Nothing useful can be
        // parsed, and the id is unknown, so drop the connection: the client's
        // close handler fails every in-flight call rather than hanging.
        buffer = '';
        socket.destroy(new Error('tool bridge request exceeded the maximum frame size'));
      }
    });
  }

  async #handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      // Answering with a null id cannot settle the caller's promise, so close
      // instead; a silent drop would hang the script until its timeout.
      socket.destroy(new Error('tool bridge received a malformed request frame'));
      return;
    }
    const id = request.id;
    const response = await this.#dispatch(request);
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...response })}\n`);
  }

  /**
   * Runs an operation after every earlier serialized one has settled.
   *
   * A script can fire many calls concurrently with `Promise.all`, but tools such
   * as `enter_worktree` mutate shared execution context: two overlapping calls
   * would leave the session pointing at whichever finished last. Only tools that
   * opt into `parallelSafe` skip this queue.
   */
  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #dispatch(request: BridgeRequest): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const started = Date.now();
    const name = typeof request.tool === 'string' ? request.tool : '';
    const record = (outcome: ToolBridgeCallRecord['outcome']) =>
      this.#onCall?.({ tool: name || '(unnamed)', outcome, durationMs: Date.now() - started });

    if (this.#callCount >= this.#limits.maxCalls) {
      record('error');
      return { ok: false, error: `Tool call limit reached (${this.#limits.maxCalls} calls per script run).` };
    }
    this.#callCount += 1;

    const tool = this.#registry.find((candidate) => candidate.name === name);
    if (!tool) {
      record('unknown_tool');
      return { ok: false, error: `Unknown tool "${name}". Available: ${this.toolNames().join(', ')}` };
    }

    let normalized: unknown;
    try {
      normalized = normalizeToolParameters(request.params ?? {}, tool.parameters);
    } catch {
      normalized = request.params ?? {};
    }

    if (isZodToolParameterSchema(tool.parameters)) {
      const parsed = tool.parameters.safeParse(normalized);
      if (!parsed.success) {
        record('invalid_params');
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return { ok: false, error: `Invalid parameters for "${name}": ${issues}` };
      }
      normalized = parsed.data;
    }

    const approvalError = await this.#refuseIfApprovalRequired(tool, normalized);
    if (approvalError) {
      record('approval_required');
      return { ok: false, error: approvalError };
    }

    const run = async () => {
      if (this.#stopped) throw new Error('the script that made this call has already finished');
      return tool.execute(normalized, this.#toolContext);
    };

    try {
      const result = (await this.#isParallelSafe(tool, normalized)) ? await run() : await this.#serialize(run);
      record('ok');
      return { ok: true, result: serializeResult(result, this.#limits.maxResultChars) };
    } catch (error) {
      record('error');
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Mirrors the run loop's rule: only a definition that declares itself
   * parallel-safe may overlap with another call. A predicate that throws is
   * treated as unsafe.
   */
  async #isParallelSafe(tool: AnyToolDefinition, params: unknown): Promise<boolean> {
    const declared = tool.parallelSafe;
    if (declared === undefined || declared === false) return false;
    if (declared === true) return true;
    try {
      return (
        (await (declared as (p: unknown, c?: unknown) => boolean | Promise<boolean>)(params, this.#toolContext)) ===
        true
      );
    } catch {
      return false;
    }
  }

  /**
   * Returns an explanatory error when the tool would have prompted the user.
   * A `needsApproval` that throws is treated as "would prompt": refusing an
   * uncertain call is the safe direction at this boundary.
   */
  async #refuseIfApprovalRequired(tool: AnyToolDefinition, params: unknown): Promise<string | null> {
    let required: boolean;
    try {
      required = (await tool.needsApproval(params, this.#toolContext)) === true;
    } catch {
      required = true;
    }
    if (!required) return null;
    return (
      `"${tool.name}" needs user approval, and a script inside the sandbox cannot raise an approval prompt. ` +
      `Call ${tool.name} directly as a tool instead, or narrow the arguments so it no longer requires approval.`
    );
  }
}
