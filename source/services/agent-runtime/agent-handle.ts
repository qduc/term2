import type { AgentHandle, AgentPermissions, AgentLimits, RunInput, RunResult, RunErrorCode } from './types.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { ExecutionBudget } from './execution-budget.js';
import { createRootBudget } from './execution-budget.js';
import { validateAttachments, serializeAttachments } from './text-attachment.js';
import { validateOutputSchema, formatOutputContract, parseAndValidateOutput } from './structured-output.js';

/**
 * Deterministically serialize a context record value for injection into
 * instructions. Accepts Record<string, unknown> (ordinary object literals).
 * Stable key ordering is ensured via JSON.stringify with sorted keys.
 *
 * Functions, symbols, bigints, and circular references are REJECTED
 * with an Error rather than silently changed.
 */
function serializeAgentContext(context: Record<string, unknown>): string | Error {
  // Pre-scan for unsupported value types before serialization.
  // Uses a visited set to detect circular references.
  function scanUnsupported(value: unknown, visited: WeakSet<object> = new WeakSet()): string | undefined {
    if (typeof value === 'function') return 'functions';
    if (typeof value === 'symbol') return 'symbols';
    if (typeof value === 'bigint') return 'bigints';
    if (typeof value === 'undefined') return 'undefined';
    if (value === null || typeof value !== 'object') return undefined;

    // Detect circular references
    if (visited.has(value as object)) return 'circular references';
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) {
        const err = scanUnsupported(item, visited);
        if (err) return err;
      }
      return undefined;
    }
    for (const key of Object.keys(value as object)) {
      const err = scanUnsupported((value as Record<string, unknown>)[key], visited);
      if (err) return err;
    }
    return undefined;
  }

  const unsupported = scanUnsupported(context);
  if (unsupported) {
    return new Error(
      `Context contains unsupported value type: ${unsupported}. Only plain JSON-serializable values (strings, numbers, booleans, null, arrays, objects) are accepted.`,
    );
  }

  try {
    // Stable deterministic serialization: sort keys alphabetically.
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(context).sort()) {
      sorted[key] = context[key];
    }
    const serialized = JSON.stringify(sorted);
    return serialized;
  } catch (err: any) {
    return new Error(err?.message ?? 'Context is not JSON-serializable');
  }
}

function errorResult<T>(status: RunResult<T>['status'], code: RunErrorCode, message: string): RunResult<T> {
  return {
    status,
    error: { code, message },
  };
}

/**
 * Convert internal resolved coarse permissions + scopes back to the
 * public `AgentPermissions` shape for inspection via `handle.permissions`.
 */
function coarseToPublicPermissions(def: ResolvedAgentDefinition): AgentPermissions {
  const tools: string[] = [];
  if (def.permissions.canRead) {
    tools.push('read_file', 'grep', 'glob', 'read_code_outline', 'code_context_search');
  }
  if (def.permissions.canWrite) {
    tools.push('search_replace', 'create_file', 'apply_patch');
  }
  if (def.permissions.canRunShell) {
    tools.push('shell');
  }
  if (def.permissions.canSearchWeb) {
    tools.push('web_search', 'web_fetch');
  }
  if (def.permissions.canUseNestedAgents) {
    tools.push('run_subagent', 'ask_mentor');
  }

  // Show filesystem when either coarse flag is on or scopes are defined
  const hasFilesystemAuth = def.permissions.canRead || def.permissions.canWrite || def.filesystemScope !== undefined;
  // Show network when either coarse flag is on or scopes are defined
  const hasNetworkAuth = def.permissions.canSearchWeb || def.networkScope !== undefined;

  return {
    tools: tools.length > 0 ? tools : undefined,
    filesystem: hasFilesystemAuth
      ? { read: def.filesystemScope?.read ?? [], write: def.filesystemScope?.write ?? [] }
      : undefined,
    network: hasNetworkAuth ? { hosts: def.networkScope ?? [] } : undefined,
    agents: def.permissions.canUseNestedAgents ? { create: true } : undefined,
  };
}

/**
 * Compose the full model-visible instructions with explicit separate sections:
 * task, base instructions, skill instructions, context, attachments, output contract.
 */
function composeInstructions(
  baseInstructions: string,
  skillInstructions: string,
  context: Record<string, unknown> | undefined,
  attachmentsStr: string,
  outputContract: string,
  task: string,
): string {
  const parts: string[] = [];

  // Task
  parts.push(`## Task\n\n${task}`);

  // Base instructions
  parts.push(`## Instructions\n\n${baseInstructions}`);

  // Skill instructions
  if (skillInstructions) {
    parts.push(`## Skill Guidance\n\n${skillInstructions}`);
  }

  // Context
  if (context) {
    const contextStr = serializeAgentContext(context);
    // Error already validated above
    if (!(contextStr instanceof Error)) {
      parts.push(`## Context\n\n${contextStr}`);
    }
  }

  // Attachments
  if (attachmentsStr) {
    parts.push(attachmentsStr.trimStart());
  }

  // Output contract
  if (outputContract) {
    parts.push(outputContract.trimStart());
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Core AgentHandle implementation bound to a ResolvedAgentDefinition.
 * Public run() validates resolution errors, attachments, structured output,
 * and context before composing model-visible instructions and delegating to
 * the executor.
 */
export class AgentHandleImpl implements AgentHandle {
  readonly #definition: ResolvedAgentDefinition;
  readonly #logger: ILoggingService;
  readonly #executor: ExecutorFn;

  constructor(definition: ResolvedAgentDefinition, logger: ILoggingService, executor: ExecutorFn) {
    this.#definition = definition;
    this.#logger = logger;
    this.#executor = executor;
  }

  get name(): string {
    return this.#definition.name;
  }

  get model(): { provider: string; model: string } {
    return { ...this.#definition.model };
  }

  get permissions(): AgentPermissions {
    return coarseToPublicPermissions(this.#definition);
  }

  get limits(): AgentLimits {
    return { ...this.#definition.limits };
  }

  async run<T = string>(input: RunInput): Promise<RunResult<T>> {
    // ── Resolution errors ──
    if (this.#definition.resolutionErrors.length > 0) {
      const fatalCodes = new Set([
        'invalid_model_policy',
        'unknown_tool',
        'permission_denied',
        'unsupported_permission_scope',
        'unknown_skill',
      ]);
      const fatalError = this.#definition.resolutionErrors.find((e) => fatalCodes.has(e.code));
      if (fatalError) {
        return errorResult<T>('failed', fatalError.code as RunErrorCode, fatalError.message);
      }
    }

    // ── maxCost preflight rejection ──
    // maxCost cannot be enforced at runtime because reliable provider-neutral
    // pricing is unavailable. Requesting it produces a typed fatal error
    // before any execution occurs.
    if (this.#definition.limits.maxCost !== undefined) {
      return errorResult<T>(
        'failed',
        'limit_validation_error',
        'maxCost is not supported. Reliable provider-neutral pricing is unavailable. ' +
          'Remove maxCost from AgentLimits to proceed.',
      );
    }

    // ── Validate context ──
    if (input.context) {
      const ctxErr = serializeAgentContext(input.context);
      if (ctxErr instanceof Error) {
        return errorResult<T>('failed', 'agent_error', `Invalid context: ${ctxErr.message}`);
      }
    }

    // ── Validate attachments ──
    let attachmentsStr = '';
    if (input.attachments && input.attachments.length > 0) {
      const attachResult = validateAttachments(input.attachments);
      if (attachResult.errors.length > 0) {
        return errorResult<T>('failed', 'invalid_attachment', attachResult.errors.join('; '));
      }
      attachmentsStr = serializeAttachments(input.attachments);
    }

    // ── Validate structured output ──
    let outputContract = '';
    if (input.output) {
      const schemaErr = validateOutputSchema(input.output);
      if (schemaErr) {
        return errorResult<T>('failed', schemaErr.code, schemaErr.message);
      }
      outputContract = formatOutputContract(input.output);
    }

    // ── Compose full instructions ──
    const instructions = composeInstructions(
      this.#definition.instructions,
      this.#definition.skillInstructions,
      input.context,
      attachmentsStr,
      outputContract,
      input.task,
    );

    // ── Execute ──
    const budget = createRootBudget({
      maxChildren: this.#definition.limits.maxChildren,
      maxDepth: this.#definition.limits.maxDepth,
      maxConcurrency: this.#definition.limits.maxConcurrency,
      maxTokens: this.#definition.limits.maxTokens,
    });
    const rawResult = await this.#executor<T>({
      definition: this.#definition,
      instructions,
      input,
      logger: this.#logger,
      budget,
    });

    // ── Post-process structured output ──
    if (input.output && rawResult.status === 'completed' && typeof rawResult.output === 'string') {
      const parsed = parseAndValidateOutput<T>(rawResult.output as string, input.output);
      if ('error' in parsed) {
        return {
          status: 'failed',
          error: parsed.error,
        };
      }
      rawResult.output = parsed.value;
    }

    return rawResult;
  }
}

/** Input to the core executor, stripping all resolution concerns. */
export interface ExecutorInput {
  definition: ResolvedAgentDefinition;
  instructions: string;
  input: RunInput;
  logger: ILoggingService;
  /** Execution-tree budget for tracking aggregate resource usage. */
  budget: ExecutionBudget;
}

/** Core executor function signature. */
export type ExecutorFn = <T = string>(input: ExecutorInput) => Promise<RunResult<T>>;
