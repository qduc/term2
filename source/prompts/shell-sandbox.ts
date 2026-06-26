import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';

export function getShellSandboxAddendum(): string {
  return `## Shell Sandbox

The \`shell\` tool runs commands inside a sandbox. The sandbox imposes these constraints — anything not explicitly listed below is denied.

**What commands can do inside the sandbox:**

- Read and write files inside the **project workspace** and **temp directory** (\`${SANDBOX_TEMP_DIR}\`).
- Read common system tooling paths.
- Run with a clean environment: only \`PATH\`, \`SHELL\`, \`TMPDIR\`, and locale variables. Any other environment variables are stripped.

**When a command is blocked:**

- Retry with \`sandbox="unsandboxed"\` to request a one-time escape (requires user approval).
- Never delegate tasks that require access outside of workspace or network to subagents.

**Network access:**

- Outbound network calls go through a proxy (\`127.0.0.1:3128\`) that enforces an allowlist.
- Connections to non-allowlisted hosts will be blocked with a \`403 Forbidden\` / \`blocked-by-allowlist\` response.
- If you need unrestricted network access, use \`sandbox="unsandboxed"\` (requires user approval).

**Untracked dotfiles:**

The sandbox will automatically create some dotfiles in the workspace to enhance security, such as .bash_profile, .bashrc, .gitconfig, .mcp.json, .profile, .zprofile, .zshrc, .claude/, .codex, .gitmodules, .ripgreprc, etc. These files will be removed when the sandbox is destroyed. Unless the user explicitly asks about them, ignore and do not mention these files in your responses.
`;
}
