import { SafetyStatus } from '../constants.js';
import type { CommandHandler, CommandHandlerHelpers, CommandHandlerResult } from './types.js';

const INLINE_EVAL_FLAGS = new Set(['-e', '--eval', '-p']);
const INTERPRETER_METADATA_FLAGS = new Set(['-h', '--help', '-v', '--version']);
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash']);
const SCRIPT_INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3']);

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.bash', '.zsh', '.dash', '.pl', '.rb'];

function getCommandName(node: any, extractWordText: CommandHandlerHelpers['extractWordText']): string | undefined {
  return node?.name?.text || (node?.name && extractWordText(node.name));
}

function getSuffixWords(node: any, extractWordText: CommandHandlerHelpers['extractWordText']): string[] {
  if (!Array.isArray(node?.suffix)) {
    return [];
  }

  return node.suffix
    .map((arg: any) => extractWordText(arg))
    .filter((value: string | undefined): value is string => {
      return typeof value === 'string' && value.length > 0;
    });
}

function isMetadataCommand(args: string[]): boolean {
  return args.some((arg) => INTERPRETER_METADATA_FLAGS.has(arg));
}

function isInlineEvalCommand(args: string[]): boolean {
  return args.some((arg) => INLINE_EVAL_FLAGS.has(arg));
}

function isInlineShellCommand(args: string[]): boolean {
  return args.some((arg) => {
    if (!arg.startsWith('-') || arg.startsWith('--')) {
      return false;
    }

    return arg.includes('c');
  });
}

function isLikelyScriptPath(value: string): boolean {
  if (!value || value.startsWith('-') || value.startsWith('--')) {
    return false;
  }

  if (value.startsWith('/')) {
    return false;
  }

  if (value.startsWith('./') || value.startsWith('../')) {
    return true;
  }

  if (value.includes('/')) {
    return true;
  }

  return SCRIPT_EXTENSIONS.some((extension) => value.endsWith(extension));
}

function buildSandboxResult(reason: string): CommandHandlerResult {
  return {
    status: SafetyStatus.YELLOW,
    reasons: [reason],
    execution: {
      requiresSandbox: true,
      sandboxReason: reason,
    },
  };
}

export const scriptHandler: CommandHandler = {
  handle(node: any, helpers: CommandHandlerHelpers): CommandHandlerResult {
    const { extractWordText } = helpers;
    const commandName = getCommandName(node, extractWordText);
    const args = getSuffixWords(node, extractWordText);

    if (!commandName) {
      return { status: SafetyStatus.GREEN, reasons: [] };
    }

    if (SCRIPT_INTERPRETERS.has(commandName)) {
      if (isMetadataCommand(args)) {
        return { status: SafetyStatus.GREEN, reasons: [] };
      }

      if (isInlineEvalCommand(args)) {
        return buildSandboxResult(`${commandName} inline evaluation requires sandbox`);
      }

      if ((commandName === 'python' || commandName === 'python3') && args.includes('-c')) {
        return buildSandboxResult(`${commandName} inline evaluation requires sandbox`);
      }

      const firstPositionalArg = args.find((arg) => !arg.startsWith('-'));
      if (firstPositionalArg && isLikelyScriptPath(firstPositionalArg)) {
        return buildSandboxResult(`${commandName} script execution requires sandbox: ${firstPositionalArg}`);
      }

      return { status: SafetyStatus.GREEN, reasons: [] };
    }

    if (SHELL_INTERPRETERS.has(commandName) && isInlineShellCommand(args)) {
      return buildSandboxResult(`${commandName} inline shell execution requires sandbox`);
    }

    if (isLikelyScriptPath(commandName)) {
      return buildSandboxResult(`local script execution requires sandbox: ${commandName}`);
    }

    return { status: SafetyStatus.GREEN, reasons: [] };
  },
};
