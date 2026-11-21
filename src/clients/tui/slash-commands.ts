import { COMMAND_SECTIONS } from './menus/legacy-commands.js';

export function helpText(): string {
  const sections = COMMAND_SECTIONS.map(([section, commands]) =>
    [
      section,
      ...commands.filter(({ alias }) => !alias).map(({ name, description }) => `/${name} — ${description}`),
    ].join('\n'),
  ).join('\n\n');
  return `Commands\n\n${sections}\n\nRetry options\n/retry turn regenerates from the original prompt\n/retry tool continues from the last tool result\n\nSettings\nUse Tab or ←/→ to switch sections. Type to search.\nRestore a default with /settings reset <key>\n\nKeyboard shortcuts\nCtrl+C: clear draft or interrupt; press again to exit\nCtrl+O: choose model · Ctrl+T: choose reasoning effort\n@: complete paths · !: shell`;
}
