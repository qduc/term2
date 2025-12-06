import parse from 'bash-parser';

// The set of binary names strictly forbidden from automatic execution
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

/**
 * Recursively inspects an AST node to find dangerous commands.
 */
function containsDangerousCommand(node: any): boolean {
	if (!node) return false;

	if (Array.isArray(node)) {
		return node.some(containsDangerousCommand);
	}

	// Direct command like `rm -rf /`
	if (node.type === 'Command') {
		const name = node.name?.text || (node.name && node.name.parts && node.name.parts.map((p: any) => p.text).join(''));
		if (typeof name === 'string' && BLOCKED_COMMANDS.has(name)) {
			return true;
		}

		// Check arguments' suffix for nested substitutions and subshells
		if (node.suffix && node.suffix.some((s: any) => containsDangerousCommand(s))) {
			return true;
		}

		return false;
	}

	// Logical expressions (&&, ||)
	if (node.type === 'LogicalExpression') {
		return containsDangerousCommand(node.left) || containsDangerousCommand(node.right);
	}

	// Pipelines (cmd1 | cmd2)
	if (node.type === 'Pipeline') {
		return (node.commands || []).some((c: any) => containsDangerousCommand(c));
	}

	// Subshells ( ... )
	if (node.type === 'Subshell') {
		return containsDangerousCommand(node.list);
	}

	// `$( ... )` or backticks
	if (node.type === 'CommandSubstitution') {
		return (node.commands || []).some((c: any) => containsDangerousCommand(c));
	}

	// Script / program top-level
	if (node.type === 'Script' || node.type === 'Program') {
		return (node.commands || []).some((c: any) => containsDangerousCommand(c));
	}

	// Generic traversal for unknown node shapes
	for (const key of Object.keys(node)) {
		const v = (node as any)[key];
		if (typeof v === 'object' && v !== null) {
			if (containsDangerousCommand(v)) return true;
		}
	}

	return false;
}

/**
 * Validate command safety using an AST parser.
 * Returns true when a command requires user approval.
 * Throws for invalid/empty inputs.
 */
export function validateCommandSafety(command: string): boolean {
	if (!command || typeof command !== 'string' || command.trim().length === 0) {
		throw new Error('Command cannot be empty');
	}

	try {
		const ast = parse(command, {mode: 'bash'});

		if (ast && ast.commands) {
			return (ast.commands as any[]).some(node => containsDangerousCommand(node));
		}

		return false;
	} catch (err) {
		// Fail-closed: unknown / unparsable commands require manual approval
		// eslint-disable-next-line no-console
		console.warn('Command parsing failed, requiring manual approval:', err);
		return true;
	}
}
