import fs from 'node:fs';

/**
 * Give a fixture its own copy of the built tree, for tests that patch or delete built modules.
 *
 * Copies only what the CLI loads at run time: source maps and type declarations are about three
 * quarters of dist/'s files and nothing imports them. The copy is synchronous on purpose:
 * `fs.promises.cp` handles each of dist/'s thousands of entries as separate thread-pool work and
 * took 1.1 s idle and over 3 s on a loaded runner, against about 0.1 s for `fs.cpSync`.
 */
export function copyBuiltCli(source: string, target: string): void {
  fs.cpSync(source, target, { recursive: true, filter: (file) => !/\.(?:map|d\.ts)$/.test(file) });
}
