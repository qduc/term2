import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';
import { isSecretKey } from './sandbox-env.js';

export type SandboxReadPolicy = 'credential-denylist' | 'home-denylist';

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
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

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

export function createSandboxRuntimeConfig(options: CreateSandboxRuntimeConfigOptions = {}): SandboxRuntimeConfig {
  const home = os.homedir();
  const readPolicy = options.readPolicy ?? 'credential-denylist';
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
  const denyRead = readPolicy === 'home-denylist' ? [home, '/etc', '/var', '/root', '/private/var'] : credentialFiles;
  const allowRead =
    readPolicy === 'home-denylist'
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

  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      ...(allowRead ? { allowRead } : {}),
      allowWrite: [workspaceRoot, tmpDir],
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
