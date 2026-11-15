/**
 * Hints for the one mistake models make with path-like parameters: passing a glob
 * ("*.go", "src/**\/*.ts") where an exact path is wanted. The underlying tools
 * report only that a path with that literal name does not exist, which does not say
 * the pattern belongs in a different parameter.
 */
import path from 'node:path';

const GLOB_CHARACTERS = /[*?[]/;

export const looksLikeGlob = (value: string): boolean => GLOB_CHARACTERS.test(value);

const quoted = (value: string): string => JSON.stringify(value);

/**
 * A scripted call arrives with its path already made absolute; the pattern the
 * model wrote is the part relative to the working directory.
 */
const asWritten = (value: string, cwd: string): string => {
  if (!path.isAbsolute(value) || !path.isAbsolute(cwd)) return value;
  const relative = path.relative(cwd, value);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? value : relative;
};

/** `grep` takes a directory or file as `path`; the file filter is `include`. */
export const grepGlobPathHint = (searchPath: string, cwd: string): string => {
  const pattern = quoted(asWritten(searchPath, cwd));
  return `\npath ${pattern} is a glob pattern, not a path; pass it as include: ${pattern} and set path to a directory such as ".".`;
};

/** `glob` takes the pattern as `pattern`; `path` is only the directory to search in. */
export const globGlobPathHint = (searchPath: string, cwd: string): string => {
  const pattern = quoted(asWritten(searchPath, cwd));
  return `\npath ${pattern} is a glob pattern, not a directory; pass it as pattern: ${pattern} (path is only the directory to search in).`;
};

/** `read_file` reads one exact file; patterns are expanded by `glob`. */
export const readFileGlobPathNote = (filePath: string, cwd: string): string => {
  if (!looksLikeGlob(filePath)) return '';
  const pattern = quoted(asWritten(filePath, cwd));
  return ` (path ${pattern} is a glob pattern, and read_file reads one exact file; list matching files with glob, pattern: ${pattern}, and read each path it returns)`;
};
