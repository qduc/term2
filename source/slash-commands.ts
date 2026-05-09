export type SlashCommandCompletion =
  | { type: 'model'; trigger: string }
  | { type: 'settings'; trigger: string; resetTrigger: string }
  | { type: 'setting-value'; trigger: string; settingKey: string };

export interface SlashCommand {
  name: string;
  description: string;
  action: (args?: string) => boolean | void;
  expectsArgs?: boolean;
  completion?: SlashCommandCompletion;
}
