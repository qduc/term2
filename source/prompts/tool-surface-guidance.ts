/** Routing for file/search/web/edit tools, selected by whether run_code exists. */

export type ScriptEditorSurface = 'patch' | 'editors' | 'none';

export function getScriptPrimaryToolsAddendum(editorSurface: ScriptEditorSurface): string {
  const editorBullets =
    editorSurface === 'patch'
      ? [
          '- Edit with `tools.apply_patch`; create new files with a `*** Add File:` patch.',
          '  Do not write files with `cat`, heredocs, Python, or other shell tricks. Formatting commands and bulk mechanical rewrites do not need an editor tool.',
        ]
      : editorSurface === 'editors'
      ? [
          '- Edit with `tools.search_replace` or `tools.create_file`. Do not write files with `cat`, heredocs, Python, or other shell tricks. Formatting commands and bulk mechanical rewrites do not need an editor tool.',
        ]
      : ['- File editing tools are not available in this session.'];
  const header = editorSurface === 'none' ? '## File, search, and web tools' : '## File, search, and edit tools';
  const bullets = [
    '- Inspect files with `tools.read_file`, `tools.grep`, `tools.glob`, and code-context tools when present.',
    '- For an exact substring or code symbol, call `tools.grep({ pattern, fixed_strings: true })`; otherwise `pattern` is a regular expression, so regex metacharacters must be escaped.',
    ...editorBullets,
    '- For multiline edit text or data containing quotes, backticks, or `${...}`, pass it through the `run_code` `inputs` parameter instead of embedding it in JavaScript source.',
    '- Web: `tools.web_search` and `tools.web_fetch`.',
    '- `shell` is a direct tool for terminal commands, builds, git, and scripts; `tools.shell` does not exist inside `run_code`. Do not use Python to read files when `tools.read_file` is available.',
  ];
  const toolsIntro = editorSurface === 'none' ? 'File, search, and web tools' : 'File, search, web, and edit tools';
  return `${header}\n\n${toolsIntro} are not on your direct tool list. Call them as \`tools.<name>(params)\` inside \`run_code\`. Use \`tools.describe(name)\` when you need a schema.\n\n${bullets.join(
    '\n',
  )}`;
}

export function getDirectEditorToolsAddendum(): string {
  return `## File, search, and edit tools

Use apply_patch or the other file editors as direct tools when they are on your tool list. Do not write files with \`cat\`, heredocs, or other shell tricks when those editors exist. Formatting commands and bulk mechanical rewrites do not need an editor tool.

Do not use Python for file I/O when a simple shell command or apply_patch would suffice.`;
}
