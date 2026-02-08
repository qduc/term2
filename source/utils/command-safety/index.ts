import parse from 'bash-parser';
import { SafetyStatus, ALLOWED_COMMANDS, BLOCKED_COMMANDS } from './constants.js';
import { extractWordText } from './utils.js';
import { hasFindDangerousExecution, hasFindSuspiciousFlags } from './find-helpers.js';
import { analyzePathRisk } from './path-analysis.js';
import { getCommandHandler } from './handlers/index.js';
import type { CommandHandlerHelpers } from './handlers/index.js';
import type { ILoggingService } from '../../services/service-interfaces.js';

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

/**
 * Classify command into a SafetyStatus (GREEN/YELLOW/RED)
 */
export function classifyCommand(commandString: string, loggingService?: ILoggingService): SafetyStatus {
  try {
    const reasons: string[] = [];
    const truncatedCommand = commandString.substring(0, 200);
    const logger = getLogger(loggingService);

    logger.security('Classifying command safety', {
      command: truncatedCommand,
    });
    const ast = parse(commandString, { mode: 'bash' });
    let worstStatus: SafetyStatus = SafetyStatus.GREEN;

    const analyzePathRiskWithLogger = (p: string | undefined) => analyzePathRisk(p, logger);

    function upgradeStatus(s: SafetyStatus, reason?: string) {
      if (worstStatus === SafetyStatus.RED) return;
      if (s === SafetyStatus.RED) worstStatus = SafetyStatus.RED;
      else if (s === SafetyStatus.YELLOW && worstStatus === SafetyStatus.GREEN) worstStatus = SafetyStatus.YELLOW;
      if (reason) reasons.push(`${s}: ${reason}`);
    }

    function traverse(node: any): void {
      if (!node) return;

      if (Array.isArray(node)) return node.forEach(traverse);

      if (node.type === 'Command') {
        const name =
          node.name?.text || (node.name && node.name.parts && node.name.parts.map((p: any) => p.text).join(''));
        if (typeof name === 'string') {
          if (BLOCKED_COMMANDS.has(name)) {
            upgradeStatus(SafetyStatus.RED, `blocked command: ${name}`);
            return;
          }
          if (!ALLOWED_COMMANDS.has(name)) {
            upgradeStatus(SafetyStatus.YELLOW, `unknown or unlisted command: ${name}`);
          }
        }

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
            };
            const result = handler.handle(node, helpers);
            upgradeStatus(result.status, result.reasons.join('; '));
            return;
          }
        }

        // Generic argument processing for commands without specialized handlers
        if (node.suffix) {
          for (const arg of node.suffix) {
            // Handle redirects
            if (arg?.type === 'Redirect') {
              const fileText = extractWordText(arg.file ?? arg);
              const pathStatus = analyzePathRiskWithLogger(fileText);
              upgradeStatus(pathStatus, `redirect to ${fileText ?? '<unknown>'}`);
              continue;
            }

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

      // recurse common shapes
      if (node.type === 'LogicalExpression') {
        traverse(node.left);
        traverse(node.right);
        return;
      }
      if (node.type === 'Pipeline') {
        (node.commands || []).forEach(traverse);
        return;
      }
      if (node.type === 'Subshell') {
        traverse(node.list);
        return;
      }
      if (node.type === 'CommandSubstitution') {
        (node.commands || []).forEach(traverse);
        return;
      }
      if (node.type === 'Script' || node.type === 'Program') {
        (node.commands || []).forEach(traverse);
        return;
      }

      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') traverse(v);
      }
    }

    if (ast && ast.commands) {
      (ast.commands as any[]).forEach(traverse);
    }

    logger.security('Command classification result', {
      command: truncatedCommand,
      status: worstStatus,
      reasons,
    });

    return worstStatus;
  } catch (e) {
    // Fail-safe: unparsable -> audit
    const logger = getLogger(loggingService);
    logger.warn('Failed to parse command, classifying as YELLOW', {
      command: commandString.substring(0, 200),
      error: e instanceof Error ? e.message : String(e),
    });
    return SafetyStatus.YELLOW;
  }
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
