/** Routing for file/search/web/edit tools, selected by whether run_code exists. */

export function getScriptPrimaryToolsAddendum(): string {
  return `## File, search, and edit tools

File, search, web, and edit tools are not on your direct tool list. Call them as \`tools.<name>(params)\` inside \`run_code\`. Use \`tools.describe(name)\` when you need a schema.

- Inspect files with \`tools.read_file\`, \`tools.grep\`, \`tools.glob\`, and code-context tools when present.
- Edit with \`tools.apply_patch\`, \`tools.search_replace\`, or \`tools.create_file\` as available in the script namespace. Do not write files with \`cat\`, heredocs, or other shell tricks when those editors exist. Formatting commands and bulk mechanical rewrites do not need an editor tool.
- Web: \`tools.web_search\` and \`tools.web_fetch\`.
- \`shell\` remains a direct tool for terminal commands, builds, git, and scripts. Do not use Python for file I/O when \`tools.read_file\` or a script editor can do the job.`;
}

export function getDirectEditorToolsAddendum(): string {
  return `## File, search, and edit tools

Use apply_patch or the other file editors as direct tools when they are on your tool list. Do not write files with \`cat\`, heredocs, or other shell tricks when those editors exist. Formatting commands and bulk mechanical rewrites do not need an editor tool.

Do not use Python for file I/O when a simple shell command or apply_patch would suffice.`;
}
