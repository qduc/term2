import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Publication requires an already-built, clean, exact-tag release. Do not rebuild
// or relabel here: that would hide a wrong selected ref or stale artifact.
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const requireIdentity = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const info = JSON.parse(await readFile(new URL('../dist/build-info.json', import.meta.url), 'utf8'));
  const tag = `v${version}`;
  const head = git('rev-parse', '--verify', 'HEAD');
  requireIdentity(git('status', '--porcelain') === '', 'checkout is dirty; build and publish from clean tagged source');
  requireIdentity(git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`) === head, `${tag} must point to HEAD`);
  if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    requireIdentity(process.env.GITHUB_REF === `refs/tags/${tag}`, `workflow tag must be ${tag}`);
  }
  requireIdentity(
    info.release === true,
    'dist/build-info.json must have release: true; rebuild from clean tagged source',
  );
  requireIdentity(info.version === version, `build version must equal package version ${version}`);
  requireIdentity(info.commit === head, 'build commit must equal HEAD; rebuild the release artifact');
  console.log(`[release-identity] OK: ${tag} at ${head}`);
} catch (error) {
  console.error(`[release-identity] Refusing publication: ${error.message}`);
  process.exitCode = 1;
}
