import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function writeBuildInfo({ root, dist, runGit }) {
  const { version: packageVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const hash = runGit(['rev-parse', '--verify', 'HEAD']);
  const dirty = runGit(['status', '--porcelain'])?.length > 0;
  const exactVersionTag = hash && runGit(['tag', '--points-at', 'HEAD'])?.split('\n').includes(`v${packageVersion}`);
  const isRelease = Boolean(hash && exactVersionTag && !dirty);
  const version = isRelease
    ? packageVersion
    : hash
    ? `${packageVersion}-dev+${hash.slice(0, 7)}`
    : `${packageVersion}-dev (commit hash unavailable; built outside a Git checkout)`;
  await writeFile(
    path.join(dist, 'build-info.json'),
    `${JSON.stringify(
      {
        version,
        commit: hash,
        release: isRelease,
        limitation: hash ? null : 'commit hash unavailable; built outside a Git checkout',
      },
      null,
      2,
    )}\n`,
  );
}

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const runGit = (args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await writeBuildInfo({ root, dist, runGit });
}
