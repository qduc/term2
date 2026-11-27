/** Routing for file/search/web/edit tools, selected by whether run_code exists. */

export type ScriptEditorSurface = 'patch' | 'editors' | 'none';

/** Render Bare's tool guidance from the same effective surface used by registration. */
export function renderBareToolGuidance(
  content: string,
  options: {
    fileReadEnabled: boolean;
    shellEnabled: boolean;
    backgroundShellEnabled?: boolean;
    editorSurface: ScriptEditorSurface;
  },
): string {
  const tools: string[] = [];
  const rules: string[] = [];
  if (options.fileReadEnabled) tools.push('- read_file: Read file contents');
  if (options.shellEnabled) {
    tools.push('- shell: Execute shell commands');
    rules.push('- Use shell for file operations like ls, rg, and find.');
  }
  if (options.backgroundShellEnabled) {
    rules.push(
      '- To wait for something (CI, a deploy, a slow command), start one background shell command that exits when the wait is over, then end your turn: its exit wakes you. Make it exit on every final state (success, failure, cancelled, timeout), not only success. Never sleep or poll in the foreground.',
    );
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
