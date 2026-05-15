import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import envPaths from 'env-paths';
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

const SHELL_COMPOSITION = /[|><;&`]|\$\(/;

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
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_COMPOSITION.test(trimmed)) return false;
  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  return RTK_COMMANDS.has(firstToken);
}

export function wrapWithRtk(command: string, rtkPath: string): string {
  return `"${rtkPath}" ${command}`;
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
