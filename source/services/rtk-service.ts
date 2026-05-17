import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import envPaths from 'env-paths';
import { parse } from 'unbash';
import type { ILoggingService } from './service-interfaces.js';

export const RTK_VERSION = 'v0.40.0';
export const RTK_REPO = 'rtk-ai/rtk';
export const RTK_ASSET_CHECKSUMS: Record<string, string> = {
  'rtk-aarch64-apple-darwin.tar.gz': '60c2c325b4edf0367cfa9716ac2e2c888abcd065eff45d01510da6561ab82e3c',
  'rtk-aarch64-unknown-linux-gnu.tar.gz': '1d0087ad62a182c0833c2251ac678b5e05356418d91aa57305ac51a126c9b102',
  'rtk-x86_64-apple-darwin.tar.gz': '8eac502fb812056973da2a8c2f0c00e1427ba5f71bd14c01520bc540630cb98a',
  'rtk-x86_64-unknown-linux-musl.tar.gz': 'a75d210a445874106bc16da2b4efba01d36d297afa33ec134728f2d5f42ef5af',
};

const RTK_COMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'cargo',
  'pytest',
  'go',
  'rg',
  'grep',
  'cat',
  'ls',
  'read',
  'smart',
  'find',
  'diff',
  'gh',
  'jest',
  'vitest',
  'playwright',
  'rspec',
  'rake',
  'err',
  'test',
  'lint',
  'biome',
  'tsc',
  'next',
  'prettier',
  'clippy',
  'ruff',
  'golangci-lint',
  'rubocop',
  'pip',
  'bundle',
  'prisma',
  'aws',
  'docker',
]);

// Returns the char offsets where an rtk prefix should be inserted (sorted
// descending so splicing right-to-left keeps earlier offsets valid), or null
// when the command must not be wrapped at all.
//
// We only walk the *top-level* composition (logical operators, sequencing).
// We deliberately do NOT descend into subshells, compound lists,
// loops/conditionals, functions, or command substitution: rewriting those
// risks changing execution semantics, which is never worth a little token
// saving. Pipelines are skipped wholesale — every segment's stdout is the
// next segment's stdin, so altering any of them corrupts the consumer's
// input. A command is eligible only if its name is allowlisted, it is not
// backgrounded, and it has no redirection (rtk yields no benefit there).
function hasUnparsedTrailingInput(command: string, ast: { commands?: unknown[] }): boolean {
  if (!Array.isArray(ast.commands) || ast.commands.length === 0) return false;
  const lastCommandEnd = ast.commands.reduce<number>((end, node: any) => Math.max(end, node?.end ?? 0), 0);
  const tail = command.slice(lastCommandEnd);
  return !/^\s*;?\s*(#.*)?$/.test(tail);
}

function collectRtkWrapOffsets(command: string): number[] | null {
  let ast: { commands?: unknown[]; errors?: { message: string }[] };
  try {
    ast = parse(command) as { commands?: unknown[]; errors?: { message: string }[] };
  } catch {
    return null;
  }
  if (ast.errors && ast.errors.length > 0) {
    return null;
  }
  if (!ast || !Array.isArray(ast.commands)) return null;
  if (hasUnparsedTrailingInput(command, ast)) return null;

  const offsets: number[] = [];
  let bail = false;

  function hasRedirect(node: any): boolean {
    return node.redirects?.length > 0;
  }

  function isEligible(node: any): boolean {
    if (!node || node.type !== 'Command') return false;
    const name: string | undefined = node.name?.text;
    if (!name || !RTK_COMMANDS.has(name)) return false;
    if (hasRedirect(node)) return false;
    return true;
  }

  function visit(node: any): void {
    if (bail || !node || typeof node !== 'object') return;
    switch (node.type) {
      case 'Statement': {
        if (node.background === true) return;
        if (node.redirects?.length > 0) return;
        visit(node.command);
        return;
      }
      case 'Command': {
        if (!isEligible(node)) return;
        const offset = node.name?.pos;
        if (typeof offset !== 'number' || offset < 0 || offset > command.length) {
          // Never guess an insertion point — abandon wrapping entirely.
          bail = true;
          return;
        }
        offsets.push(offset);
        return;
      }
      case 'AndOr':
        node.commands?.forEach(visit);
        return;
      case 'Pipeline':
        // Never wrap inside a pipeline: each command's stdout is the next
        // command's stdin, so altering any segment's output changes the
        // consumer's input. Leave the whole pipeline untouched.
        return;
      default:
        // Subshell / CompoundList / If / For / While / Function / etc.
        // Leave the original text untouched.
        return;
    }
  }

  for (const node of ast.commands) visit(node);

  if (bail || offsets.length === 0) return null;
  return offsets.sort((a, b) => b - a);
}

export interface RtkServiceDeps {
  loggingService: ILoggingService;
  fetchImpl?: (url: string) => Promise<Response>;
  extractImpl?: (tarPath: string, destDir: string) => { status: number | null };
  platform?: NodeJS.Platform;
  arch?: string;
  cacheDir?: string;
  assetChecksums?: Record<string, string>;
}

export function resolveRtkAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return 'rtk-x86_64-unknown-linux-musl.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'rtk-aarch64-unknown-linux-gnu.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'rtk-x86_64-apple-darwin.tar.gz';
  if (platform === 'darwin' && arch === 'arm64') return 'rtk-aarch64-apple-darwin.tar.gz';
  return null;
}

export function getRtkBinaryPath(opts?: { cacheDir?: string }): string {
  const cacheDir = opts?.cacheDir ?? envPaths('term2').cache;
  return path.join(cacheDir, 'rtk', RTK_VERSION, 'rtk');
}

export function isRtkSupportedCommand(command: string): boolean {
  return collectRtkWrapOffsets(command) !== null;
}

export function wrapWithRtk(command: string, rtkPath: string): string {
  const offsets = collectRtkWrapOffsets(command);
  if (!offsets) return command;
  const prefix = `"${rtkPath}" `;
  let result = command;
  for (const offset of offsets) {
    result = result.slice(0, offset) + prefix + result.slice(offset);
  }
  return result;
}

function defaultExtract(tarPath: string, destDir: string): { status: number | null } {
  const result = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], {
    stdio: 'pipe',
    windowsHide: true,
  });
  return { status: result.status };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function ensureRtkInstalled(deps: RtkServiceDeps): Promise<string | null> {
  const {
    loggingService,
    fetchImpl = fetch,
    extractImpl = defaultExtract,
    platform = process.platform,
    arch = process.arch,
    cacheDir,
    assetChecksums = RTK_ASSET_CHECKSUMS,
  } = deps;

  const binaryPath = getRtkBinaryPath({ cacheDir });

  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  const asset = resolveRtkAsset(platform, arch);
  if (!asset) {
    loggingService.warn('rtk: no binary available for this platform/arch', { platform, arch });
    return null;
  }

  try {
    const url = `https://github.com/${RTK_REPO}/releases/download/${RTK_VERSION}/${asset}`;
    loggingService.debug('rtk: downloading binary', { url });

    const response = await fetchImpl(url);
    if (!response.ok) {
      loggingService.warn('rtk: download request failed', { status: response.status, url });
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const expectedChecksum = assetChecksums[asset];
    if (!expectedChecksum) {
      loggingService.warn('rtk: missing checksum for release asset', { asset });
      return null;
    }

    const actualChecksum = sha256(buffer);
    if (actualChecksum !== expectedChecksum) {
      loggingService.warn('rtk: checksum verification failed', {
        asset,
        expected: expectedChecksum,
        actual: actualChecksum,
      });
      return null;
    }

    const destDir = path.dirname(binaryPath);
    fs.mkdirSync(destDir, { recursive: true });

    const stamp = Date.now();
    const tmpTar = path.join(destDir, `rtk-dl-${stamp}.tar.gz`);
    const tmpExtractDir = path.join(os.tmpdir(), `rtk-extract-${stamp}`);

    fs.writeFileSync(tmpTar, buffer);
    fs.mkdirSync(tmpExtractDir, { recursive: true });

    try {
      const extractResult = extractImpl(tmpTar, tmpExtractDir);

      try {
        fs.unlinkSync(tmpTar);
      } catch {}

      if (extractResult.status !== 0) {
        loggingService.warn('rtk: extraction failed', { status: extractResult.status });
        return null;
      }

      const extractedBinary = path.join(tmpExtractDir, 'rtk');
      if (!fs.existsSync(extractedBinary)) {
        loggingService.warn('rtk: binary not found after extraction');
        return null;
      }

      fs.renameSync(extractedBinary, binaryPath);
      fs.chmodSync(binaryPath, 0o755);

      loggingService.debug('rtk: installed successfully', { path: binaryPath });
      return binaryPath;
    } finally {
      try {
        fs.rmSync(tmpExtractDir, { recursive: true, force: true });
      } catch {}
    }
  } catch (error) {
    loggingService.warn('rtk: installation failed', { error: String(error) });
    return null;
  }
}
