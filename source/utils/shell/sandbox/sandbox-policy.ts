import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';
import { isSecretKey } from './sandbox-env.js';

export type SandboxReadPolicy = 'standard' | 'strict';

export type ShellSandboxMode = 'default' | 'unsandboxed';

export type SandboxAvailability =
  | { type: 'available' }
  | { type: 'disabled' }
  | { type: 'unsupported_platform'; reason: string }
  | { type: 'missing_dependency'; reason: string }
  | { type: 'initialization_failed'; reason: string };

export interface ShellSandboxRunner {
  availability(): Promise<SandboxAvailability>;
  wrap(
    command: string,
    options: {
      cwd: string;
      config?: SandboxRuntimeConfig;
      signal?: AbortSignal;
    },
  ): Promise<{ command: string; diagnostics?: string[] }>;
  cleanupAfterCommand?(): void | Promise<void>;
  annotateFailure(command: string, stderr: string): string;
}

export interface CreateSandboxRuntimeConfigOptions {
  readPolicy?: SandboxReadPolicy;
  allowReadExtra?: string[];
  allowNetworking?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onProtectedFiltered?: (filtered: readonly string[]) => void;
}

const copilotAllowlist = [
  // GitHub public URLs
  'https://github.com/login/*',
  'https://github.com/copilot/*',
  'https://api.github.com/user',
  'https://api.github.com/copilot_internal/*',
  'https://collector.github.com/*',
  'https://copilot-telemetry.githubusercontent.com/telemetry',
  'https://default.exp-tas.com',
  'https://copilot-proxy.githubusercontent.com',
  'https://origin-tracker.githubusercontent.com',
  'https://*.githubcopilot.com/*',
  'https://*.individual.githubcopilot.com',
  'https://*.business.githubcopilot.com',
  'https://*.enterprise.githubcopilot.com',
  'https://copilot-reports.github.com',
  'https://copilot-reports-*.b01.azurefd.net',
  'https://usagereports*.blob.core.windows.net',

  // Copilot voice features
  'https://ai.azure.com',
  'https://api.catalog.azureml.ms',
  'https://*.api.azureml.ms',
  'https://amlwlrt4*.blob.core.windows.net',

  // Container Registries: Docker
  '172.18.0.1',
  'ghcr.io',
  'registry.hub.docker.com',
  '*.docker.io',
  '*.docker.com',
  'production.cloudflare.docker.com',
  'auth.docker.io',
  'quay.io',
  'mcr.microsoft.com',
  'gcr.io',
  'public.ecr.aws',

  // GitHub: Content & API
  '*.githubusercontent.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'lfs.github.com',
  'github-cloud.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
  'codeload.github.com',
  'scanning-api.github.com',
  'api.mcp.github.com',
  'uploads.github.com/copilot/chat/attachments/',

  // GitHub: Actions Artifact Storage
  'productionresultssa0.blob.core.windows.net',
  'productionresultssa1.blob.core.windows.net',
  'productionresultssa2.blob.core.windows.net',
  'productionresultssa3.blob.core.windows.net',
  'productionresultssa4.blob.core.windows.net',
  'productionresultssa5.blob.core.windows.net',
  'productionresultssa6.blob.core.windows.net',
  'productionresultssa7.blob.core.windows.net',
  'productionresultssa8.blob.core.windows.net',
  'productionresultssa9.blob.core.windows.net',
  'productionresultssa10.blob.core.windows.net',
  'productionresultssa11.blob.core.windows.net',
  'productionresultssa12.blob.core.windows.net',
  'productionresultssa13.blob.core.windows.net',
  'productionresultssa14.blob.core.windows.net',
  'productionresultssa15.blob.core.windows.net',
  'productionresultssa16.blob.core.windows.net',
  'productionresultssa17.blob.core.windows.net',
  'productionresultssa18.blob.core.windows.net',
  'productionresultssa19.blob.core.windows.net',

  // C# / .NET
  'nuget.org',
  'dist.nuget.org',
  'api.nuget.org',
  'nuget.pkg.github.com',
  'dotnet.microsoft.com',
  'pkgs.dev.azure.com',
  'builds.dotnet.microsoft.com',
  'dotnetcli.blob.core.windows.net',
  'nugetregistryv2prod.blob.core.windows.net',
  'azuresearch-usnc.nuget.org',
  'azuresearch-ussc.nuget.org',
  'dc.services.visualstudio.com',
  'dot.net',
  'download.visualstudio.microsoft.com',
  'dotnetcli.azureedge.net',
  'ci.dot.net',
  'www.microsoft.com',
  'oneocsp.microsoft.com',
  'www.microsoft.com/pkiops/crl/',

  // Dart
  'pub.dev',
  'pub.dartlang.org',
  'storage.googleapis.com/pub-packages/',
  'storage.googleapis.com/dart-archive/',

  // Go
  'go.dev',
  'golang.org',
  'proxy.golang.org',
  'sum.golang.org',
  'pkg.go.dev',
  'goproxy.io',
  'storage.googleapis.com/proxy-golang-org-prod/',

  // Haskell
  'haskell.org',
  '*.hackage.haskell.org',
  'get-ghcup.haskell.org',
  'downloads.haskell.org',

  // Java
  'www.java.com',
  'jdk.java.net',
  'api.adoptium.net',
  'adoptium.net',
  'search.maven.org',
  'maven.apache.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'maven.pkg.github.com',
  'maven-central.storage-download.googleapis.com',
  'maven.google.com',
  'maven.oracle.com',
  'jcenter.bintray.com',
  'oss.sonatype.org',
  'repo.spring.io',
  'gradle.org',
  'services.gradle.org',
  'plugins.gradle.org',
  'plugins-artifacts.gradle.org',
  'repo.grails.org',
  'download.eclipse.org',
  'download.oracle.com',

  // Node.js / JavaScript
  'npmjs.org',
  'npmjs.com',
  'registry.npmjs.com',
  'registry.npmjs.org',
  'skimdb.npmjs.com',
  'npm.pkg.github.com',
  'api.npms.io',
  'nodejs.org',
  'yarnpkg.com',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'deb.nodesource.com',
  'get.pnpm.io',
  'bun.sh',
  'deno.land',
  'registry.bower.io',
  'binaries.prisma.sh',

  // Perl
  'cpan.org',
  'www.cpan.org',
  'metacpan.org',
  'cpan.metacpan.org',

  // PHP
  'repo.packagist.org',
  'packagist.org',
  'getcomposer.org',

  // Python
  'pypi.python.org',
  'pypi.org',
  'pip.pypa.io',
  '*.pythonhosted.org',
  'files.pythonhosted.org',
  'bootstrap.pypa.io',
  'conda.binstar.org',
  'conda.anaconda.org',
  'binstar.org',
  'anaconda.org',
  'download.pytorch.org',
  'repo.continuum.io',
  'repo.anaconda.com',

  // Ruby
  'rubygems.org',
  'api.rubygems.org',
  'rubygems.pkg.github.com',
  'bundler.rubygems.org',
  'gems.rubyforge.org',
  'gems.rubyonrails.org',
  'index.rubygems.org',
  'cache.ruby-lang.org',
  '*.rvm.io',

  // Rust
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'sh.rustup.rs',
  'static.rust-lang.org',

  // Swift
  'download.swift.org',
  'swift.org',
  'cocoapods.org',
  'cdn.cocoapods.org',

  // HashiCorp
  'releases.hashicorp.com',
  'apt.releases.hashicorp.com',
  'yum.releases.hashicorp.com',
  'registry.terraform.io',

  // JSON Schema
  'json-schema.org',
  'json.schemastore.org',

  // Playwright
  'playwright.download.prss.microsoft.com',
  'cdn.playwright.dev',
  'playwright.azureedge.net',
  'playwright-akamai.azureedge.net',
  'playwright-verizon.azureedge.net',
  'storage.googleapis.com/chrome-for-testing-public',

  // Ubuntu
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'ppa.launchpad.net',
  'keyserver.ubuntu.com',
  'azure.archive.ubuntu.com',
  'api.snapcraft.io',

  // Debian
  'deb.debian.org',
  'security.debian.org',
  'keyring.debian.org',
  'packages.debian.org',
  'debian.map.fastlydns.net',
  'apt.llvm.org',

  // Fedora
  'dl.fedoraproject.org',
  'mirrors.fedoraproject.org',
  'download.fedoraproject.org',

  // CentOS
  'mirror.centos.org',
  'vault.centos.org',

  // Alpine
  'dl-cdn.alpinelinux.org',
  'pkg.alpinelinux.org',

  // Arch
  'mirror.archlinux.org',
  'archlinux.org',

  // SUSE
  'download.opensuse.org',

  // Red Hat
  'cdn.redhat.com',

  // Common Package Sources
  'packagecloud.io',
  'packages.cloud.google.com',
  'packages.microsoft.com',

  // Other
  'dl.k8s.io',
  'pkgs.k8s.io',
];

// Paths the sandbox must never allow writing to, regardless of where term2
// was launched from. Two classes:
//   - EXACT: only when cwd (resolved) is exactly the path
//   - SUBTREE: when cwd (resolved) is the path or any descendant
// Both Linux and macOS paths are listed; the runtime drops non-existent paths
// per platform. This list is hardcoded on purpose: it is the floor of what
// "do not destroy the user's system" means, and giving users a setting to
// weaken it would defeat the point. See docs/sandbox-filesystem-read-hardening.md.
const EXACT_PROTECTED_WRITE_PATHS = [
  '$HOME', // resolved via os.homedir() at use time
  '/root',
  '/var',
  '/private/var',
  '/mnt',
  '/media',
  '/srv',
  '/opt',
] as const;

const SUBTREE_PROTECTED_WRITE_PATHS = [
  '/etc',
  '/private/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/proc',
  '/sys',
  '/dev',
  '/Library',
  '/System',
  '/System/Library',
] as const;

// Common dev locations are intentionally NOT protected:
//   /usr/local, /opt/homebrew, /tmp, /private/tmp
// These host Homebrew, local builds, temp worktrees, and cache dirs.
// Blocking them would break normal development workflows.
//
// Writable carve-outs that sit *inside* a SUBTREE-protected path. Without
// this, the `/usr` subtree guard below would remove `/usr/local` (and
// descendants like `/usr/local/src`) from allowWrite, contradicting the
// documented exception above. Checked before subtree protection.
const WRITABLE_SUBTREE_EXCEPTIONS = ['/usr/local'] as const;

function expandHomePath(filePath: string, home: string): string {
  if (filePath === '~') {
    return home;
  }
  if (filePath.startsWith('~/')) {
    return path.join(home, filePath.slice(2));
  }
  return filePath;
}

function resolveCurrentRuntimeRoot(home: string): string | undefined {
  try {
    const realExecPath = fs.realpathSync(process.execPath);
    if (!realExecPath.startsWith(`${home}${path.sep}`)) {
      return undefined;
    }
    return path.dirname(path.dirname(realExecPath));
  } catch {
    return undefined;
  }
}

// Normalize $HOME the same way workspaceRoot is (realpathSync) so the exact
// home guard still fires when os.homedir() is a symlink path and the launch
// cwd is $HOME: workspaceRoot becomes the real path while a bare
// path.resolve(home) would stay the symlink path. Best-effort: fall back to
// path.resolve when the home directory cannot be resolved.
function resolveHomePath(home: string): string {
  try {
    return fs.realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}

export function isPathProtected(target: string, home: string): boolean {
  const resolved = path.resolve(target);
  const resolvedHome = resolveHomePath(home);

  for (const protectedPath of EXACT_PROTECTED_WRITE_PATHS) {
    if (resolved === path.resolve(protectedPath === '$HOME' ? resolvedHome : protectedPath)) {
      return true;
    }
  }

  // Writable carve-outs inside a subtree-protected path take precedence over
  // subtree protection so documented exceptions (e.g. /usr/local) stay writable.
  for (const exceptionPath of WRITABLE_SUBTREE_EXCEPTIONS) {
    const resolvedException = path.resolve(exceptionPath);
    if (resolved === resolvedException || resolved.startsWith(resolvedException + path.sep)) {
      return false;
    }
  }

  for (const protectedPath of SUBTREE_PROTECTED_WRITE_PATHS) {
    const resolvedProtected = path.resolve(protectedPath);
    if (resolved === resolvedProtected) return true;
    if (resolved.startsWith(resolvedProtected + path.sep)) return true;
  }

  return false;
}

export function createSandboxRuntimeConfig(options: CreateSandboxRuntimeConfigOptions = {}): SandboxRuntimeConfig {
  const home = os.homedir();
  const readPolicy = options.readPolicy ?? 'standard';
  const workspaceRoot = fs.realpathSync(options.cwd ?? process.cwd());
  const tmpDir = SANDBOX_TEMP_DIR;
  const appCacheDir = path.join(home, '.cache', 'term2-nodejs');
  const rtkConfigDir = path.join(home, '.config', 'rtk');
  const rtkDataDir = path.join(home, '.local', 'share', 'rtk');
  const safeHomeReadPaths = [
    path.join(home, '.gitconfig'),
    path.join(home, '.config', 'git'),
    path.join(home, '.npm'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.pnpm-store'),
    resolveCurrentRuntimeRoot(home),
  ].filter((filePath): filePath is string => Boolean(filePath));
  const credentialFiles = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.docker'),
    path.join(home, '.netrc'),
    path.join(home, '.git-credentials'),
    path.join(home, '.bash_history'),
    path.join(home, '.zsh_history'),
    path.join(home, '.npmrc'),
    path.join(home, '.pypirc'),
    path.join(home, '.kube'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.gem'),
    path.join(home, '.gemrc'),
    path.join(home, '.config', 'hub'),
    path.join(home, '.docker', 'config.json'),
  ];
  const defaultCredentialEnvVars = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
  ];
  // Env protection layering (see docs/sandbox-filesystem-read-hardening.md §5):
  // Layer 1 (authoritative): createSandboxEnvironment() in sandbox-env.ts drops every env
  //   key not on a tiny allowlist of known-safe values (PATH, SHELL, TMPDIR, locale, …).
  //   Secrets never reach the child because they are not allowlisted, not because we named them.
  // Layer 2 (defense-in-depth): credentials.envVars below unsets the same keys at the sandbox
  //   runtime level (bwrap --unsetenv / Seatbelt -u). It is intentionally small and
  //   auto-populated from the live env via isSecretKey so it stays exhaustive without hardcoding.
  //   It earns its keep only if Layer 1 ever regresses; do not treat it as the primary gate.
  const presentSecretEnvVars = Object.keys(options.env ?? process.env).filter(isSecretKey);
  const credentialEnvVars = Array.from(new Set([...defaultCredentialEnvVars, ...presentSecretEnvVars]));
  const allowReadExtra = (options.allowReadExtra ?? []).map((filePath) => expandHomePath(filePath, home));
  const denyRead = readPolicy === 'strict' ? [home, '/etc', '/var', '/root', '/private/var'] : credentialFiles;
  const allowRead =
    readPolicy === 'strict'
      ? [
          workspaceRoot,
          tmpDir,
          appCacheDir,
          rtkConfigDir,
          rtkDataDir,
          ...safeHomeReadPaths,
          ...allowReadExtra,
          '/usr',
          '/bin',
          '/sbin',
          '/lib',
          '/lib64',
          '/opt',
          '/Library',
          '/System/Library',
          '/usr/local',
          '/opt/homebrew',
        ]
      : undefined;

  const rawAllowWrite = [workspaceRoot, tmpDir];
  const protectedFiltered = rawAllowWrite.filter((p) => isPathProtected(p, home));
  const allowWrite = rawAllowWrite.filter((p) => !isPathProtected(p, home));
  if (protectedFiltered.length > 0) {
    options.onProtectedFiltered?.(protectedFiltered);
  }

  const allowNetworking = options.allowNetworking ?? false;
  return {
    network: {
      allowedDomains: copilotAllowlist,
      deniedDomains: allowNetworking ? [] : ['*'],
      strictAllowlist: allowNetworking ? false : true,
      allowLocalBinding: allowNetworking,
    },
    filesystem: {
      denyRead,
      ...(allowRead ? { allowRead } : {}),
      allowWrite,
      denyWrite: [],
      allowGitConfig: true,
    },
    credentials: {
      files: credentialFiles.map((filePath) => ({ path: filePath, mode: 'deny' as const })),
      envVars: credentialEnvVars.map((name) => ({ name, mode: 'deny' as const })),
    },
  };
}

export const SANDBOX_ESCAPE_INSTRUCTION =
  'Sandbox blocked this command. To request a one-shot escape, call shell again with sandbox="unsandboxed"; user approval will be required.';
