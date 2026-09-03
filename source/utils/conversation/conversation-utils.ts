import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

/**
 * Pure utility functions extracted from use-conversation.ts for testability.
 * These contain no React state or side effects.
 */

/**
 * State tracked during streaming event processing.
 */
export interface StreamingState {
  accumulatedText: string;
  flushedTextLength: number;
  currentBotMessageId: string | null;
  accumulatedReasoningText: string;
  flushedReasoningLength: number;
  textWasFlushed: boolean;
  currentReasoningMessageId: string | null;
  /**
   * The live "Compacting context..." notice, so the completion can replace it in place and a
   * second compaction item in the same response supersedes the first instead of stacking.
   */
  contextCompactionMessageId: string | null;
  latestUsage: import('../ai/token-usage.js').NormalizedUsage | null;
}

/**
 * Normalize tool arguments from JSON string or object.
 * Provider implementations may send arguments as either format.
 */
export function parseToolArguments(rawArgs: unknown): unknown {
  if (typeof rawArgs !== 'string') {
    return rawArgs;
  }
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return rawArgs;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return rawArgs;
  }
}

/**
 * Build a human-readable command string for display in the UI.
 * Each tool has its own formatting logic.
 */

export function formatToolCommand(toolName: string, args: Record<string, unknown> | null | undefined): string {
  if (!args) {
    return toolName;
  }

  if (toolName === 'shell') {
    const cmd = args.command ?? args.commands;
    if (typeof cmd === 'string' && cmd.trim()) {
      return cmd;
    }
    if (Array.isArray(cmd) && cmd.length > 0) {
      return cmd.join('\n');
    }
    return toolName;
  }

  if (toolName === 'grep') {
    if (args.pattern) {
      return `grep "${args.pattern}" ${args.path ?? '.'}`;
    }
    return toolName;
  }

  if (toolName === TOOL_NAME_SEARCH_REPLACE) {
    return `${TOOL_NAME_SEARCH_REPLACE} "${args.search_content ?? ''}" → "${args.replace_content ?? ''}" ${
      args.path ?? ''
    }`;
  }

  if (toolName === TOOL_NAME_APPLY_PATCH) {
    return `${TOOL_NAME_APPLY_PATCH} ${args.type ?? 'unknown'} ${args.path ?? ''}`;
  }

  if (toolName === 'ask_mentor') {
    return `ask_mentor: ${args.question ?? ''}`;
  }

  return formatGenericToolCommand(toolName, args);
}

/** Preferred argument keys for the generic tool label, most identifying first. */
const GENERIC_PARAM_KEY_ORDER = ['path', 'pattern', 'command', 'query', 'url', 'file', 'symbol', 'question'];

const MAX_GENERIC_PARAMS = 3;
const MAX_GENERIC_LABEL_LENGTH = 100;

const formatScalarParam = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const singleLine = value.replaceAll(/\s+/g, ' ').trim();
    if (!singleLine) return undefined;
    return /\s/.test(singleLine) ? `"${singleLine}"` : singleLine;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};

/**
 * Fallback label for tools without a dedicated formatter: the tool name plus
 * up to three scalar `key=value` parameters. Always a single bounded line so
 * it is safe for the task panel and pending tool messages.
 */
function formatGenericToolCommand(toolName: string, args: Record<string, unknown>): string {
  const orderedKeys = [
    ...GENERIC_PARAM_KEY_ORDER.filter((key) => key in args),
    ...Object.keys(args).filter((key) => !GENERIC_PARAM_KEY_ORDER.includes(key)),
  ];
  const params: string[] = [];
  for (const key of orderedKeys) {
    if (params.length >= MAX_GENERIC_PARAMS) break;
    const formatted = formatScalarParam(args[key]);
    if (formatted === undefined) continue;
    params.push(`${key}=${formatted}`);
  }
  if (params.length === 0) return toolName;
  const label = `${toolName} ${params.join(' ')}`;
  return label.length > MAX_GENERIC_LABEL_LENGTH ? `${label.slice(0, MAX_GENERIC_LABEL_LENGTH - 1)}…` : label;
}

/**
 * Create initial streaming state for a new message send/approval flow.
 */
export function createStreamingState(): StreamingState {
  return {
    accumulatedText: '',
    flushedTextLength: 0,
    currentBotMessageId: null,
    accumulatedReasoningText: '',
    flushedReasoningLength: 0,
    textWasFlushed: false,
    currentReasoningMessageId: null,
    contextCompactionMessageId: null,
    latestUsage: null,
  };
}

/**
 * Enhance error messages for common API key issues.
 */
export function enhanceApiKeyError(message: string): string {
  if (
    message.includes('OPENAI_API_KEY') ||
    (message.includes('401') && message.toLowerCase().includes('unauthorized'))
  ) {
    return (
      'OpenAI API key is not configured or invalid. Please set the OPENAI_API_KEY environment variable. ' +
      'Get your API key from: https://platform.openai.com/api-keys'
    );
  }
  return message;
}

/**
 * Check if an error message indicates max turns exceeded.
 */
export function isMaxTurnsError(message: string): boolean {
  return message.includes('Max turns') && message.includes('exceeded');
}

/**
 * Format shell command output for display.
 */
export function createShellMessageOutput(returnCode: number | null, stdout: string, stderr: string): string {
  const parts: string[] = [];

  // Combine stdout and stderr
  const trimmedStdout = stdout.replace(/\n+$/, '');
  const trimmedStderr = stderr.replace(/\n+$/, '');

  if (trimmedStdout) {
    parts.push(trimmedStdout);
  }
  if (trimmedStderr) {
    parts.push(trimmedStderr);
  }

  let output = parts.join('\n');

  // Add return code if available
  if (returnCode !== null) {
    output += `\n\nReturn code: ${returnCode}`;
  }

  return output;
}
