import path from 'node:path';

export const HOME_DIRECTORY_START_WARNING =
  'Warning: you are starting term2 in non-lite mode from your home directory.\n' +
  'This can expose a large amount of local context. Continue? [y/N] ';

export function isExactDirectory(candidatePath: string, directoryPath: string): boolean {
  return path.resolve(candidatePath) === path.resolve(directoryPath);
}

export function shouldWarnOnHomeDirectoryStart(options: {
  cwd: string;
  homeDir: string;
  isNonLiteStart: boolean;
}): boolean {
  const cwd = path.resolve(options.cwd);
  const homeDir = path.resolve(options.homeDir);
  const rootDir = path.parse(cwd).root;

  return options.isNonLiteStart && (cwd === homeDir || cwd === rootDir);
}

export function isAffirmativeAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

export async function confirmHomeDirectoryStart(question: () => Promise<string>): Promise<boolean> {
  return isAffirmativeAnswer(await question());
}
