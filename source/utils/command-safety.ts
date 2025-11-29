// Dangerous command patterns that always require approval
const DANGEROUS_PATTERNS = [
	// Destructive operations
	/\b(rm|rmdir)\b/i,
	/\b(dd|mkfs|fsck)\b/i,
	/\bfind\b.*\b(delete|exec rm)\b/i,
	/\b(mv|cp)\b.*[&|;]\s*(rm|dd)\b/i,

	// System modifications
	/\b(sudo|chmod|chown|chgrp)\b/i,
	/\b(killall|kill -9)\b/i,
	/\b(shutdown|reboot|halt)\b/i,

	// Package/system changes
	/\b(apt|yum|brew|npm|pip|gem)\b.*(remove|uninstall|autoremove|purge)\b/i,
	/\b(npm|yarn|pnpm)\b.*(install|add)\b.*(--save|--global|--force)\b/i,

	// Credential/data exposure
	/\b(curl|wget)\b.*(http|ftp)/i,
	/\becho\b.*(password|secret|token|key)/i,
	/\b(cat|grep)\b.*\/etc\/(shadow|passwd|sudoers)/i,

	// Network operations
	/\b(iptables|ufw|firewall)\b/i,
	/\b(netstat|ss|nc|ncat|telnet|ssh)\b/i,
];

/**
 * Check if a command matches dangerous patterns
 * @returns True if command is dangerous
 */
export function isDangerousCommand(command: string): boolean {
	if (!command || typeof command !== 'string') {
		return false;
	}

	const trimmed = command.trim();
	return DANGEROUS_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Validate command safety with multiple checkpoints
 * @returns True if command requires approval
 * @throws If command is invalid
 */
export function validateCommandSafety(command: string): boolean {
	// Check 1: Command must be a non-empty string
	if (
		!command ||
		typeof command !== 'string' ||
		command.trim().length === 0
	) {
		throw new Error('Command cannot be empty');
	}

	// Check 2: Check if command is dangerous
	if (isDangerousCommand(command)) {
		return true; // Always requires approval
	}

	return false;
}
