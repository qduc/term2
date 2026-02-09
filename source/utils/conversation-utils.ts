import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';

/**
 * Pure utility functions extracted from use-conversation.ts for testability.
 * These contain no React state or side effects.
 */

/**
 * State tracked during streaming event processing.
 */
export interface StreamingState {
  accumulatedText: string;
  accumulatedReasoningText: string;
  flushedReasoningLength: number;
  textWasFlushed: boolean;
  currentReasoningMessageId: number | null;
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

  return toolName;
}

/**
 * Create initial streaming state for a new message send/approval flow.
 */
export function createStreamingState(): StreamingState {
  return {
    accumulatedText: '',
    accumulatedReasoningText: '',
    flushedReasoningLength: 0,
    textWasFlushed: false,
    currentReasoningMessageId: null,
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
