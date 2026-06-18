export type SlashCommandCompletion =
  | { type: 'model'; trigger: string }
  | { type: 'settings'; trigger: string; resetTrigger: string }
  | { type: 'setting-value'; trigger: string; settingKey: string }
  | { type: 'skills'; trigger: string };

export interface SlashCommand {
  name: string;
  description: string;
  action: (args?: string) => boolean | void;
  expectsArgs?: boolean;
  completion?: SlashCommandCompletion;
}

export function resolveSlashCommand(commands: SlashCommand[], commandName: string): SlashCommand | undefined {
  const normalizedName = commandName.toLowerCase();
  const exactMatch = commands.find((command) => command.name.toLowerCase() === normalizedName);
  if (exactMatch) return exactMatch;

  const prefixMatches = commands.filter((command) => command.name.toLowerCase().startsWith(normalizedName));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}
