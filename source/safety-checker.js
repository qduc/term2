import { OpenAI } from 'openai';

const client = new OpenAI();

/**
 * Evaluates if a bash command is safe to execute automatically
 * @param {string} command - The bash command to evaluate
 * @returns {Promise<{safe: boolean, reason: string}>}
 */
export async function isSafeCommand(command) {
	try {
		const response = await client.chat.completions.create({
			model: 'gpt-4.1-mini',
			messages: [
				{
					role: 'system',
					content: `You are a security expert evaluating bash commands for safety.
Analyze if the command is safe to execute automatically without user approval.

Consider DANGEROUS:
- Commands that delete, remove, or modify files/directories (rm, rmdir, mv to overwrite, >)
- Commands that change system configuration (chmod, chown, systemctl, etc.)
- Commands that install/uninstall software (apt, yum, npm install -g, pip install, etc.)
- Commands that modify user accounts or permissions
- Commands that interact with network in destructive ways (curl with -X DELETE, wget with -O to system files)
- Commands that execute arbitrary code from network sources
- Commands with sudo or elevated privileges
- Commands that shut down or reboot the system
- Commands that modify environment permanently (.bashrc, .profile, etc.)
- Commands that access sensitive files (/etc/passwd, ~/.ssh/, etc.)

Consider SAFE:
- Read-only commands (ls, cat, head, tail, grep, find without -exec, pwd, echo, etc.)
- Non-destructive information gathering (ps, top, df, du, whoami, uname, date, etc.)
- Simple calculations or text processing (wc, sort, uniq, awk for display, sed for display)
- Git read operations (git status, git log, git diff, git branch without creation)
- Package queries without installation (npm list, pip list, apt list)
- Commands that create new files in user directories (touch, echo >, mkdir in ~/)

Respond with ONLY a JSON object: {"safe": true/false, "reason": "brief explanation"}`,
				},
				{
					role: 'user',
					content: `Evaluate this command: ${command}`,
				},
			],
			temperature: 0,
			response_format: { type: 'json_object' },
		});

		const result = JSON.parse(response.choices[0].message.content);
		return result;
	} catch (error) {
		// If safety check fails, default to requiring approval (safe fallback)
		return {
			safe: false,
			reason: `Safety check failed: ${error.message}`,
		};
	}
}
