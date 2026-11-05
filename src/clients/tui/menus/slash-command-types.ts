/** Copied from rewrite/src/shared/slash-commands.ts. */
export type SlashCommandCompletion =
  | { type: 'model'; trigger: string }
  | { type: 'settings'; trigger: string; resetTrigger: string }
  | { type: 'setting-value'; trigger: string; settingKey: string }
  | { type: 'skills'; trigger: string }
  | { type: 'resume'; trigger: string }
  | { type: 'profile'; trigger: string };

export interface SlashCommand {
  name: string;
  description: string;
  action: (args?: string) => boolean | void;
  expectsArgs?: boolean;
  completion?: SlashCommandCompletion;
}
