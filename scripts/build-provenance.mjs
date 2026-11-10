/** Content receipt for the local CLI build. Not release/signing metadata.
 * Hash actual files (including untracked inputs), not mtimes or Git's index. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const receiptName = '.term2-build-provenance.json';
const outputs = { direct: 'dist' };
const commonInputs = ['scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'];
const directInputs = ['src', 'tsconfig.build.json'];

/** Stable path+content digest. Refuse links rather than miss a compiler-read target. */
function digest(root, entries, exclude = '') {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())
    throw new Error(`Cannot certify non-directory or symbolic link: ${root}`);
  const hash = createHash('sha256');
  const visit = (name) => {
    const full = path.join(root, name);
    if (name === exclude) return;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Cannot certify symbolic link: ${full}`);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(['directory', name]));
      for (const child of fs.readdirSync(full).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(['file', name, stat.size]));
      hash.update(fs.readFileSync(full));
    } else throw new Error(`Cannot certify non-file: ${full}`);
  };
  for (const entry of [...entries].sort()) visit(entry);
  return hash.digest('hex');
}

function outputDirectory(root, kind) {
  if (!Object.hasOwn(outputs, kind)) throw new Error(`Unknown build kind: ${kind}`);
  return path.join(root, outputs[kind]);
}

/** Capture the exact checkout HEAD and conservative owned input bytes. */
export function buildInputs(root, kind) {
  outputDirectory(root, kind);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`Cannot establish checkout HEAD: ${git.stderr?.trim()}`);
  const [top, head] = git.stdout.trim().split('\n');
  if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error('Expected a checkout root');
  return {
    head,
    node: process.version,
    digest: digest(root, [...commonInputs, ...(kind === 'direct' ? directInputs : [])]),
  };
}

/** Last build step only: refuse observed input changes, then certify emitted bytes. */
export function writeBuildReceipt(root, kind, before) {
  const after = buildInputs(root, kind);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${kind} build inputs changed during build`);
  const directory = outputDirectory(root, kind);
  const outputDigest = digest(directory, ['.'], `./${receiptName}`);
  fs.writeFileSync(
    path.join(directory, receiptName),
    JSON.stringify({ version: 1, kind, inputs: before, outputDigest }) + '\n',
  );
}

/** Refuse unknown/partial builds, HEAD/dirty-input drift, or replaced/deleted output. */
export function assertFreshBuild(root, kind) {
  const directory = outputDirectory(root, kind);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(directory, receiptName), 'utf8'));
  } catch {
    throw new Error(`${kind} build has no valid provenance receipt`);
  }
  if (receipt.version !== 1 || receipt.kind !== kind) throw new Error(`${kind} build has unknown provenance`);
  if (JSON.stringify(receipt.inputs) !== JSON.stringify(buildInputs(root, kind)))
    throw new Error(`${kind} build is stale: HEAD or input contents differ`);
  if (receipt.outputDigest !== digest(directory, ['.'], `./${receiptName}`))
    throw new Error(`${kind} build is stale: emitted contents differ`);
}
