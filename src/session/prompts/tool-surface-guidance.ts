/** Routing for file/search/web/edit tools, selected by whether run_code exists. */

export type ScriptEditorSurface = 'patch' | 'editors' | 'none';

/** Render Bare's tool guidance from the same effective surface used by registration. */
export function renderBareToolGuidance(
  content: string,
  options: { fileReadEnabled: boolean; shellEnabled: boolean; editorSurface: ScriptEditorSurface },
): string {
  const tools: string[] = [];
  const rules: string[] = [];
  if (options.fileReadEnabled) tools.push('- read_file: Read file contents');
  if (options.shellEnabled) {
    tools.push('- shell: Execute shell commands');
    rules.push('- Use shell for file operations like ls, rg, and find.');
  }
  if (options.fileReadEnabled) rules.push('- Use read_file to examine files instead of cat or sed.');
  if (options.editorSurface === 'editors') {
    tools.push(
      '- search_replace: Make precise edits to existing files using exact text replacement',
      '- create_file: Create files',
    );
    rules.push(
      "- Use search_replace for targeted changes. Match the tool's exact replacement schema.",
      '- Keep replacement matches short and unique; avoid including large unchanged regions.',
      '- Use create_file for new files.',
    );
  } else if (options.editorSurface === 'patch') {
    tools.push('- apply_patch: Apply patches to edit, create, or delete files');
    rules.push(
      '- Use apply_patch for targeted changes and new files. Match the patch format in its tool description.',
      '- Keep patches focused; avoid including large unchanged regions.',
    );
  }
  return content.replace('{{bare_tool_list}}', tools.join('\n')).replace('{{bare_tool_rules}}', rules.join('\n'));
}

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
    '- `shell` is available directly and as `tools.shell(...)` inside `run_code` for terminal commands, builds, git, and scripts. Both paths use the same approvals and sandbox. Do not use Python to read files when `tools.read_file` is available.',
  ];
  const toolsIntro = editorSurface === 'none' ? 'File, search, and web tools' : 'File, search, web, and edit tools';
  return `${header}\n\nFile tools on your tool list can be called directly. ${toolsIntro} are also available as \`tools.<name>(params)\` inside \`run_code\`; search and web tools use that script surface. Both paths share validation and approvals. Use \`tools.describe(name)\` when you need a script schema.\n\n${bullets.join(
    '\n',
  )}`;
}

export function getDirectEditorToolsAddendum(): string {
  return `## File, search, and edit tools

Use apply_patch or the other file editors as direct tools when they are on your tool list. Do not write files with \`cat\`, heredocs, or other shell tricks when those editors exist. Formatting commands and bulk mechanical rewrites do not need an editor tool.

Do not use Python for file I/O when a simple shell command or apply_patch would suffice.`;
}
