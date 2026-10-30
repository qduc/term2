import path from 'node:path';
export const HOME_DIRECTORY_START_WARNING = 'Warning: you are starting term2 in non-lite mode from your home directory.\n' +
    'This can expose a large amount of local context. Continue? [y/N] ';
export function isExactDirectory(candidatePath, directoryPath) {
    return path.resolve(candidatePath) === path.resolve(directoryPath);
}
export function shouldWarnOnHomeDirectoryStart(options) {
    const cwd = path.resolve(options.cwd);
    const homeDir = path.resolve(options.homeDir);
    const rootDir = path.parse(cwd).root;
    return options.isNonLiteStart && (cwd === homeDir || cwd === rootDir);
}
export function isAffirmativeAnswer(answer) {
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
}
export async function confirmHomeDirectoryStart(question) {
    return isAffirmativeAnswer(await question());
}
//# sourceMappingURL=home-directory-start-guard.js.map