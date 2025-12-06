import parse from 'bash-parser';
import path from 'path';
import {loggingService} from '../services/logging-service.js';

// 1. CONSTANTS
// Note: 'sed' is useful for read-only transformations. We allow it by default
// but add guards below to prevent in-place edits (-i) and unapproved redirections.
const ALLOWED_COMMANDS = new Set(['ls', 'pwd', 'grep', 'cat', 'echo', 'head', 'tail', 'sed']);
const BLOCKED_COMMANDS = new Set([
	// Filesystem
	'rm', 'rmdir', 'mkfs', 'dd', 'mv', 'cp',
	// System
	'sudo', 'su', 'chmod', 'chown', 'shutdown', 'reboot',
	// Network/Web
	'curl', 'wget', 'ssh', 'scp', 'netstat',
	// Package Managers / installers
	'apt', 'yum', 'npm', 'yarn', 'pnpm', 'pip', 'gem',
	// Dangerous wrappers / misc
	'eval', 'exec', 'kill', 'killall'
]);

/* legacy containsDangerousCommand removed — replaced by classifyCommand + path analysis */

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval.
 * Throws for invalid/empty inputs.
 */
export enum SafetyStatus {
	GREEN = 'GREEN',
	YELLOW = 'YELLOW',
	RED = 'RED',
}

// Extract a best-effort string for a word/arg node, including expansions.
function extractWordText(word: any): string | undefined {
	if (!word) return undefined;
	if (typeof word === 'string') return word;
	if (typeof word.text === 'string') return word.text;
	if (typeof word.value === 'string') return word.value;
	if (typeof word.content === 'string') return word.content;
	if (word.parameter) return `$${word.parameter}`;
	if (Array.isArray(word.parts)) {
		return word.parts.map((part: any) => extractWordText(part) ?? '').join('');
	}
	return undefined;
}

// 2. PATH ANALYSIS HELPER
function analyzePathRisk(inputPath: string | undefined): SafetyStatus {
	const candidate = inputPath?.trim();
	if (!candidate) return SafetyStatus.GREEN;

	// RED: Explicit home-dotfiles (.ssh, .env, etc.) even before expansion
	if (
		candidate.startsWith('~') ||
		candidate.startsWith('$HOME') ||
		candidate.startsWith('${HOME}')
	) {
		const sliced = candidate.replace(/^~/, '').replace(/^\$\{?HOME\}?/, '');
		// Check for dotfiles after home prefix
		if (/^\/\.\w+/.test(sliced) || sliced.includes('/.ssh') || sliced.includes('/.env')) {
			loggingService.security('Path risk: home dotfile', {path: candidate});
			return SafetyStatus.RED;
		}
	}

	// RED: Absolute System Paths
	if (path.isAbsolute(candidate)) {
		const SYSTEM_PATHS = ['/etc', '/dev', '/proc', '/var', '/usr', '/boot', '/bin'];
		if (SYSTEM_PATHS.some(sys => candidate.startsWith(sys))) {
			loggingService.security('Path risk: absolute system path', {path: candidate});
			return SafetyStatus.RED;
		}
		// Home dotfiles when absolute
		if (/^\/(home|Users)\/[^/]+\/\.\w+/.test(candidate) || candidate.includes('/.ssh') || candidate.includes('/.gitconfig')) {
			loggingService.security('Path risk: absolute home dotfile', {path: candidate});
			return SafetyStatus.RED;
		}
		// Other absolute paths are suspicious -> audit
		loggingService.debug('Path risk: absolute non-system path', {path: candidate});
		return SafetyStatus.YELLOW;
	}

	// RED: Directory Traversal
	if (candidate.includes('..')) {
		loggingService.security('Path risk: directory traversal detected', {path: candidate});
		return SafetyStatus.RED;
	}

	// Hidden files -> YELLOW
	const filename = path.basename(candidate);
	if (filename.startsWith('.')) {
		loggingService.debug('Path risk: hidden file', {path: candidate});
		return SafetyStatus.YELLOW;
	}

	// Sensitive extensions
	const SENSITIVE_EXTENSIONS = ['.env', '.pem', '.key', '.json'];
	if (SENSITIVE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
		loggingService.debug('Path risk: sensitive extension', {path: candidate});
		return SafetyStatus.YELLOW;
	}

	return SafetyStatus.GREEN;
}

/**
 * Classify command into a SafetyStatus (GREEN/YELLOW/RED)
 */
export function classifyCommand(commandString: string): SafetyStatus {
	try {
		const reasons: string[] = [];
		const truncatedCommand = commandString.substring(0, 200);
		loggingService.debug('Classifying command safety', {command: truncatedCommand});
		const ast = parse(commandString, {mode: 'bash'});
		let worstStatus: SafetyStatus = SafetyStatus.GREEN;

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
				const name = node.name?.text || (node.name && node.name.parts && node.name.parts.map((p: any) => p.text).join(''));
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

				if (node.suffix) {
					for (const arg of node.suffix) {
						// Redirects: analyze path risk. For `sed`, mark any redirect at least YELLOW
						if (arg?.type === 'Redirect') {
							const fileText = extractWordText(arg.file ?? arg);
							if (cmdName === 'sed')
								upgradeStatus(
									SafetyStatus.YELLOW,
									`sed with redirection to ${
										fileText ?? '<unknown>'
									}`,
								);
							const pathStatus = analyzePathRisk(fileText);
							upgradeStatus(
								pathStatus,
								`redirect to ${fileText ?? '<unknown>'}`,
							);
							continue;
						}

						const argText = extractWordText(arg);
						// Flags are normally ignored, but for `sed` the -i flag is dangerous
						// because it performs in-place edits. Detect -i and variants (e.g. -i, -i.bak, -i'')
						if (argText && argText.startsWith('-')) {
							if (cmdName === 'sed' && argText.startsWith('-i')) {
								upgradeStatus(
									SafetyStatus.RED,
									`sed in-place edit detected: ${argText}`,
								);
								continue;
							}
							continue; // other flags ignored
						}

						const pathStatus = analyzePathRisk(argText);
						// For `sed`, any explicit filename argument (non-flag) should at least
						// require approval since it reads/writes files — escalate to YELLOW
						if (cmdName === 'sed' && argText) {
							if (pathStatus === SafetyStatus.RED)
								upgradeStatus(
									pathStatus,
									`sed file argument ${argText}`,
								);
							else
								upgradeStatus(
									SafetyStatus.YELLOW,
									`sed file argument ${argText}`,
								);
							continue;
						}

						// Unknown/opaque args fall back to YELLOW
						if (!argText)
							upgradeStatus(
								SafetyStatus.YELLOW,
								'opaque or unparseable argument',
							);
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

		loggingService.debug('Command classification result', {
			command: truncatedCommand,
			status: worstStatus,
			reasons,
		});

		return worstStatus;
	} catch (e) {
		// Fail-safe: unparsable -> audit
		loggingService.warn('Failed to parse command, classifying as YELLOW', {
			command: commandString.substring(0, 200),
			error: e instanceof Error ? e.message : String(e),
		});
		return SafetyStatus.YELLOW;
	}
}

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval.
 * Throws for invalid/empty inputs OR hard-blocked RED classifications.
 */
export function validateCommandSafety(command: string): boolean {
	if (!command || typeof command !== 'string' || command.trim().length === 0) {
		throw new Error('Command cannot be empty');
	}
	loggingService.debug('Validating command safety', {command: command.substring(0, 200)});
	const status = classifyCommand(command);

	if (status === SafetyStatus.RED) {
		loggingService.security('Command validation failed: RED (forbidden)', {command: command.substring(0, 200)});
		throw new Error('Command classified as RED (forbidden)');
	}

	loggingService.debug('Validation result', {command: command.substring(0, 200), status});
	return status === SafetyStatus.YELLOW;
}
