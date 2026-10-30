/**
 * Generic adapter for the source tool definitions that the old application
 * already assembled for a model/profile/mode. This module does not assemble a
 * second tool graph or reimplement individual tools.
 */

import { z } from 'zod';
import { normalizeToolInput } from '../../../../source/lib/tool-invoke.js';
import { isCancellationError, isHarnessInvariantError } from '../../../../source/lib/harness-invariant-error.js';
import { coerceToText } from '../../../../source/tools/format-helpers.js';
import type { AnyToolDefinition, ToolRegistry as SourceToolRegistry } from '../../../../source/tools/types.js';
import type { ToolSpec } from '../../model/index.js';
import type { ApprovalRequirement, Tool, ToolContext, ToolRegistry, ToolResult } from '../index.js';

type RuntimeSchema = z.ZodTypeAny;
/**
 * These definitions must be the final definitions from the regular source
 * assembly (`getAgentDefinition` followed by the existing provider wrapper,
 * when the caller uses it). The wrapper and `original()` then share identity.
 */
export type AdoptedOriginalToolDefinition = AnyToolDefinition;
export type AdoptedSourceToolRegistry = SourceToolRegistry;

/** Context bridge for callers that already own a live application invocation context. */
export type AdoptedInvocation = {
  readonly context: unknown;
  readonly details?: unknown;
};

export type AdoptedToolRegistry = ToolRegistry & {
  /** The exact assembled source definition wrapped by `get(name)`. */
  original(name: string): AdoptedOriginalToolDefinition | undefined;
  /** Resolve configured offered names in their supplied offering order. */
  originals(names: readonly string[]): readonly AdoptedOriginalToolDefinition[];
  replaceGeneration(definitions: AdoptedSourceToolRegistry): void;
};

export type AdoptedToolRegistryOptions = {
  /**
   * Provide the source runtime's live context for original tools that need it.
   * The default context supplies only the cancellation signal and an empty
   * application context; production C1 supplies its real invocation bridge.
   */
  invocation?: (
    toolContext: ToolContext,
    definition: AdoptedOriginalToolDefinition,
    input: unknown,
  ) => AdoptedInvocation;
  /** Preserve source-engine fatal control flow when the app owns its error class. */
  isMaxTurnsExceeded?: (error: unknown) => boolean;
};

/** Reviewed read-only tools that are safe to repeat if a caller explicitly retries them. */
const IDEMPOTENT_READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
  'web_search',
  'web_fetch',
]);
let nextDisplayCallId = 0;

function isZodSchema(schema: unknown): schema is RuntimeSchema {
  return typeof (schema as { safeParse?: unknown } | null)?.safeParse === 'function';
}

function runtimeSchema(definition: AdoptedOriginalToolDefinition): RuntimeSchema | undefined {
  if (definition.canonicalParameters) return definition.canonicalParameters;
  return isZodSchema(definition.parameters) ? definition.parameters : undefined;
}

function asJsonSchema(definition: AdoptedOriginalToolDefinition): Readonly<Record<string, unknown>> {
  if (!isZodSchema(definition.parameters)) return definition.parameters;
  return z.toJSONSchema(definition.parameters) as Readonly<Record<string, unknown>>;
}

function toolSpec(definition: AdoptedOriginalToolDefinition): ToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: asJsonSchema(definition),
    ...(definition.modelTool ? { modelTool: definition.modelTool } : {}),
  };
}

function parseToolInput(definition: AdoptedOriginalToolDefinition, raw: unknown): unknown {
  const schema = runtimeSchema(definition);
  let parsed: unknown;

  if (typeof raw === 'string' && definition.parseModelArguments) {
    parsed = definition.parseModelArguments(raw);
  } else {
    const normalized = normalizeToolInput(raw, schema, definition.argumentParsing ?? 'repair');
    try {
      parsed = JSON.parse(normalized) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON arguments for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!schema) return parsed;
  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new Error(`Tool input did not match schema for ${definition.name}: ${result.error.message}`);
  return result.data;
}

function defaultInvocation(toolContext: ToolContext): AdoptedInvocation {
  return {
    context: {
      context: undefined,
      approvals: undefined,
      signal: toolContext.signal,
    },
  };
}

function approvalFor(
  definition: AdoptedOriginalToolDefinition,
  input: unknown,
  toolContext: ToolContext,
  options: AdoptedToolRegistryOptions,
): ApprovalRequirement | Promise<ApprovalRequirement> {
  const invocation = options.invocation?.(toolContext, definition, input) ?? defaultInvocation(toolContext);
  const approval = definition.needsApproval(input, invocation.context);
  const wrap = (requiresApproval: boolean): ApprovalRequirement => {
    if (!requiresApproval) return { kind: 'none' };
    const serialized = JSON.stringify(input);
    return {
      kind: 'ask',
      summary: definition.name,
      ...(serialized ? { detail: serialized } : {}),
    };
  };
  return Promise.resolve(approval).then(wrap);
}

function displayFor(
  definition: AdoptedOriginalToolDefinition,
  input: unknown,
  result: unknown,
  details?: unknown,
): unknown {
  const output = coerceToText(result);
  const detailRecord = details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined;
  const toolCall = detailRecord?.toolCall;
  const suppliedCallId =
    toolCall && typeof toolCall === 'object' ? (toolCall as { callId?: unknown }).callId : undefined;
  const callId =
    typeof suppliedCallId === 'string' && suppliedCallId.length > 0
      ? suppliedCallId
      : `adopted:${definition.name}:${(nextDisplayCallId++).toString(36)}`;
  const item = {
    type: 'function_call_output',
    toolName: definition.name,
    callId,
    arguments: input,
    output,
  };
  const messages = definition.formatCommandMessage(item, 0, new Map([[callId, input]]));
  return definition.approvalPresentation
    ? { messages, approvalPresentation: definition.approvalPresentation }
    : messages;
}

function isProviderOutput(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    if (record.type === 'text') return typeof record.text === 'string';
    if (record.type === 'image') {
      if (!('image' in record)) return false;
      const image = record.image;
      if (typeof image === 'string' || image === undefined) return true;
      if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
      const reference = image as Record<string, unknown>;
      return (
        typeof reference.id === 'string' ||
        typeof reference.url === 'string' ||
        typeof reference.fileId === 'string' ||
        typeof reference.data === 'string' ||
        reference.data instanceof Uint8Array
      );
    }
    if (record.type === 'file') {
      if (!('file' in record)) return false;
      const file = record.file;
      if (typeof file === 'string') return true;
      if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
      const reference = file as Record<string, unknown>;
      return (
        typeof reference.id === 'string' ||
        typeof reference.url === 'string' ||
        ((typeof reference.data === 'string' || reference.data instanceof Uint8Array) &&
          typeof reference.mediaType === 'string' &&
          typeof reference.filename === 'string')
      );
    }
    return false;
  });
}

function displaySafely(
  definition: AdoptedOriginalToolDefinition,
  input: unknown,
  result: unknown,
  details?: unknown,
): unknown {
  try {
    return displayFor(definition, input, result, details);
  } catch {
    // Presentation is passive: a formatter failure must not retry a completed side effect.
    return undefined;
  }
}

function adaptTool(definition: AdoptedOriginalToolDefinition, options: AdoptedToolRegistryOptions): Tool<unknown> {
  return {
    spec: toolSpec(definition),
    idempotent: IDEMPOTENT_READ_ONLY_TOOLS.has(definition.name),
    parse: (raw) => parseToolInput(definition, raw),
    approval: (input, toolContext) => approvalFor(definition, input, toolContext, options),
    async execute(input, toolContext): Promise<ToolResult> {
      const invocation = options.invocation?.(toolContext, definition, input) ?? defaultInvocation(toolContext);
      let result: unknown;
      try {
        result = await definition.execute(input, invocation.context, invocation.details);
      } catch (error) {
        if (
          toolContext.signal.aborted ||
          isCancellationError(error) ||
          isHarnessInvariantError(error) ||
          options.isMaxTurnsExceeded?.(error)
        ) {
          throw error;
        }
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          display: displaySafely(definition, input, error, invocation.details),
        };
      }
      return {
        output: coerceToText(result),
        isError:
          typeof result === 'object' &&
          result !== null &&
          'isError' in result &&
          typeof (result as { isError?: unknown }).isError === 'boolean'
            ? Boolean((result as { isError: boolean }).isError)
            : false,
        ...(isProviderOutput(result) ? { providerOutput: result } : {}),
        display: displaySafely(definition, input, result, invocation.details),
      };
    },
  };
}

/** Adapt the original assembled tool objects in order, preserving their identity for C1. */
export function createAdoptedToolRegistry(
  definitions: AdoptedSourceToolRegistry,
  options: AdoptedToolRegistryOptions = {},
): AdoptedToolRegistry {
  let originals = new Map<string, AdoptedOriginalToolDefinition>();
  let adapted = new Map<string, Tool>();
  const replaceGeneration = (next: AdoptedSourceToolRegistry) => {
    const nextOriginals = new Map<string, AdoptedOriginalToolDefinition>();
    const nextAdapted = new Map<string, Tool>();
    for (const definition of next) {
      if (nextOriginals.has(definition.name)) throw new Error(`Duplicate assembled tool name: ${definition.name}`);
      nextOriginals.set(definition.name, definition);
      nextAdapted.set(definition.name, adaptTool(definition, options));
    }
    originals = nextOriginals;
    adapted = nextAdapted;
  };
  replaceGeneration(definitions);

  return {
    get: (name) => adapted.get(name),
    available: () => [...adapted.values()],
    original: (name) => originals.get(name),
    replaceGeneration,
    originals: (names) =>
      names.map((name) => {
        const definition = originals.get(name);
        if (!definition) throw new Error(`Configured tool "${name}" is missing from the assembled tool registry`);
        return definition;
      }),
  };
}
