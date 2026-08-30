import { parse } from 'unbash';
import type { Script, Node, Command, Word, Redirect, WordPart, ParseError } from 'unbash';
import { SafetyStatus, ALLOWED_COMMANDS, BLOCKED_COMMANDS } from './constants.js';
import { extractWordText } from './utils.js';
import { hasFindDangerousExecution, hasFindSuspiciousFlags } from './find-helpers.js';
import { analyzePathRisk } from './path-analysis.js';
import { getCommandHandler } from './handlers/index.js';
import type { CommandHandlerHelpers } from './handlers/index.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';

const nullLoggingService: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

function getLogger(loggingService?: ILoggingService): ILoggingService {
  return loggingService ?? nullLoggingService;
}

function hasUnparsedTrailingInput(commandString: string, ast: Script): boolean {
  if (!Array.isArray(ast.commands) || ast.commands.length === 0) return false;
  const lastCommandEnd = ast.commands.reduce<number>((end, node) => Math.max(end, node.end ?? 0), 0);
  const tail = commandString.slice(lastCommandEnd);
  return !/^\s*;?\s*(#.*)?$/.test(tail);
}

export interface ClassifyCommandResult {
  status: SafetyStatus;
  reasons: string[];
}

/**
 * Classify command into a SafetyStatus (GREEN/YELLOW/RED)
 */
export function classifyCommand(
  commandString: string,
  loggingService?: ILoggingService,
  options?: { isSessionCreatedFile?: (path: string) => boolean },
): SafetyStatus {
  return classifyCommandDetailed(commandString, loggingService, options).status;
}

/**
 * Classify command and return both the status and the list of reasons
 * that contributed to the final status.
 */
export function classifyCommandDetailed(
  commandString: string,
  loggingService?: ILoggingService,
  options?: { isSessionCreatedFile?: (path: string) => boolean },
): ClassifyCommandResult {
  const reasons: string[] = [];
  const truncatedCommand = commandString.substring(0, 200);
  const logger = getLogger(loggingService);

  logger.security('Classifying command safety', {
    command: truncatedCommand,
  });
  let ast: Script & { errors?: ParseError[] };
  try {
    ast = parse(commandString);
  } catch (e) {
    logger.warn('Failed to parse command, classifying as YELLOW', {
      command: commandString.substring(0, 200),
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      status: SafetyStatus.YELLOW,
      reasons: [`YELLOW: failed to parse command (${e instanceof Error ? e.message : String(e)})`],
    };
  }
  if (ast.errors && ast.errors.length > 0) {
    logger.warn('Failed to parse command, classifying as YELLOW', {
      command: commandString.substring(0, 200),
      error: ast.errors.map((e) => e.message).join('; '),
    });
    return {
      status: SafetyStatus.YELLOW,
      reasons: [`YELLOW: failed to parse command (${ast.errors.map((e) => e.message).join('; ')})`],
    };
  }
  if (hasUnparsedTrailingInput(commandString, ast)) {
    return {
      status: SafetyStatus.YELLOW,
      reasons: ['YELLOW: failed to parse complete command'],
    };
  }
  let worstStatus: SafetyStatus = SafetyStatus.GREEN;

  const analyzePathRiskWithLogger = (p: string | undefined) => analyzePathRisk(p, logger);

  function upgradeStatus(s: SafetyStatus, reason?: string) {
    if (worstStatus === SafetyStatus.RED) return;
    if (s === SafetyStatus.RED) worstStatus = SafetyStatus.RED;
    else if (s === SafetyStatus.YELLOW && worstStatus === SafetyStatus.GREEN) worstStatus = SafetyStatus.YELLOW;
    if (reason) reasons.push(`${s}: ${reason}`);
  }

  function traverseWord(word: Word | WordPart | undefined | null): void {
    if (!word) return;
    if ('type' in word && word.type === 'CommandExpansion') {
      if (word.script) traverseScript(word.script);
      return;
    }
    if ('parts' in word && Array.isArray(word.parts)) {
      for (const part of word.parts) {
        traverseWord(part);
      }
    }
  }

  function traverseRedirect(redirect: Redirect): void {
    if (!redirect) return;
    if (redirect.target) {
      traverseWord(redirect.target);
      const fileText = extractWordText(redirect.target);
      const pathStatus = analyzePathRiskWithLogger(fileText);
      upgradeStatus(pathStatus, `redirect to ${fileText ?? '<unknown>'}`);
    } else {
      upgradeStatus(SafetyStatus.YELLOW, 'redirect to <unknown>');
    }
  }

  function traverseCommand(node: Command): void {
    const name = extractWordText(node.name);
    const cmdName = typeof name === 'string' ? name : undefined;

    // Check if there's a specialized handler for this command
    if (cmdName) {
      const handler = getCommandHandler(cmdName);
      if (handler) {
        const helpers: CommandHandlerHelpers = {
          extractWordText,
          analyzePathRisk: analyzePathRiskWithLogger,
          hasFindDangerousExecution,
          hasFindSuspiciousFlags,
          isSessionCreatedFile: options?.isSessionCreatedFile,
        };
        const result = handler.handle(node, helpers);
        upgradeStatus(result.status, result.reasons.join('; '));
        if (node.name) traverseWord(node.name);
        if (node.prefix) {
          for (const prefix of node.prefix) {
            if (prefix.value) traverseWord(prefix.value);
          }
        }
        if (node.suffix) {
          for (const arg of node.suffix) {
            traverseWord(arg);
          }
        }
        if (node.redirects) {
          for (const redirect of node.redirects) {
            traverseRedirect(redirect);
          }
        }
        return;
      }
    }

    if (typeof name === 'string') {
      if (BLOCKED_COMMANDS.has(name)) {
        upgradeStatus(SafetyStatus.RED, `blocked command: ${name}`);
        return;
      }
      if (!ALLOWED_COMMANDS.has(name)) {
        upgradeStatus(SafetyStatus.YELLOW, `unknown or unlisted command: ${name}`);
      }
    }

    // Handle redirects
    if (node.redirects) {
      for (const redirect of node.redirects) {
        traverseRedirect(redirect);
      }
    }

    // Generic argument processing for commands without specialized handlers
    if (node.suffix) {
      for (const arg of node.suffix) {
        traverseWord(arg);
        const argText = extractWordText(arg);
        // Skip flags (generic commands don't have special flag handling)
        if (argText && argText.startsWith('-')) {
          continue;
        }

        // Analyze path arguments
        const pathStatus = analyzePathRiskWithLogger(argText);
        // Unknown/opaque args fall back to YELLOW
        if (!argText) upgradeStatus(SafetyStatus.YELLOW, 'opaque or unparseable argument');
        else upgradeStatus(pathStatus, `argument ${argText}`);
      }
    }
  }

  function traverseNode(node: Node | null | undefined): void {
    if (!node) return;

    switch (node.type) {
      case 'Statement':
        if (node.redirects) {
          for (const redirect of node.redirects) {
            traverseRedirect(redirect);
          }
        }
        traverseNode(node.command);
        break;

      case 'Command':
        traverseCommand(node);
        break;

      case 'Pipeline':
      case 'AndOr':
        if (node.commands) {
          for (const cmd of node.commands) {
            traverseNode(cmd);
          }
        }
        break;

      case 'Subshell':
      case 'BraceGroup':
        if (node.body?.commands) {
          for (const stmt of node.body.commands) {
            traverseNode(stmt);
          }
        }
        break;

      case 'CompoundList':
        if (node.commands) {
          for (const stmt of node.commands) {
            traverseNode(stmt);
          }
        }
        break;

      case 'If':
        if (node.clause?.commands) {
          for (const stmt of node.clause.commands) traverseNode(stmt);
        }
        if (node.then?.commands) {
          for (const stmt of node.then.commands) traverseNode(stmt);
        }
        if (node.else) {
          if (node.else.type === 'If') {
            traverseNode(node.else);
          } else if (node.else.commands) {
            for (const stmt of node.else.commands) traverseNode(stmt);
          }
        }
        break;

      case 'For':
      case 'Select':
        if (node.wordlist) {
          for (const w of node.wordlist) traverseWord(w);
        }
        if (node.body?.commands) {
          for (const stmt of node.body.commands) traverseNode(stmt);
        }
        break;

      case 'While':
        if (node.clause?.commands) {
          for (const stmt of node.clause.commands) traverseNode(stmt);
        }
        if (node.body?.commands) {
          for (const stmt of node.body.commands) traverseNode(stmt);
        }
        break;

      case 'Function':
        if (node.redirects) {
          for (const redirect of node.redirects) traverseRedirect(redirect);
        }
        traverseNode(node.body);
        break;

      case 'Case':
        if (node.word) traverseWord(node.word);
        if (node.items) {
          for (const item of node.items) {
            if (item.pattern) {
              for (const p of item.pattern) traverseWord(p);
            }
            if (item.body?.commands) {
              for (const stmt of item.body.commands) traverseNode(stmt);
            }
          }
        }
        break;

      case 'Coproc':
        if (node.redirects) {
          for (const redirect of node.redirects) traverseRedirect(redirect);
        }
        traverseNode(node.body);
        break;

      case 'ArithmeticFor':
        if (node.body?.commands) {
          for (const stmt of node.body.commands) traverseNode(stmt);
        }
        break;

      case 'TestCommand':
        // TestCommand does not execute sub-commands
        break;

      case 'ArithmeticCommand':
        // Arithmetic expressions do not execute sub-commands
        break;
    }
  }

  function traverseScript(script: Script): void {
    if (script.commands) {
      for (const stmt of script.commands) {
        traverseNode(stmt);
      }
    }
  }

  if (ast) {
    traverseScript(ast);
  }

  logger.security('Command classification result', {
    command: truncatedCommand,
    status: worstStatus,
    reasons,
  });

  return { status: worstStatus, reasons };
}

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval (YELLOW or RED).
 * Throws for invalid/empty inputs.
 */
export function validateCommandSafety(command: string, loggingService?: ILoggingService): boolean {
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('Command cannot be empty');
  }
  const logger = getLogger(loggingService);
  logger.security('Validating command safety', {
    command: command.substring(0, 200),
  });
  const status = classifyCommand(command, logger);

  if (status === SafetyStatus.RED || status === SafetyStatus.YELLOW) {
    logger.security('Command validation: needs approval', {
      command: command.substring(0, 200),
      status,
    });
    return true;
  }

  logger.security('Validation result', {
    command: command.substring(0, 200),
    status,
  });
  return false;
}

// Re-export types and constants for convenience
export { SafetyStatus } from './constants.js';
