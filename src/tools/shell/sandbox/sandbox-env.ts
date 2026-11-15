import fs from 'node:fs';
import path from 'node:path';
import { resolveSandboxXdgLayout } from '../../../shared/utils/shell/temp-dir.js';
import { getActiveWorkspaceRoot } from '../../workspace/active-workspace-root.js';

// macOS Keychain trust may be unavailable to a sandboxed process.
export const SANDBOX_SYSTEM_CA_BUNDLE =
  process.platform === 'darwin' && fs.existsSync('/private/etc/ssl/cert.pem') ? '/private/etc/ssl/cert.pem' : undefined;

const ALLOWED_EXACT_KEYS = new Set(['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'HOME', 'TMUX']);

function isAllowedKey(key: string): boolean {
  return ALLOWED_EXACT_KEYS.has(key) || key === 'LANG' || key.startsWith('LC_');
}

export function isSecretKey(key: string): boolean {
  return (
    /(^|_)API_KEY$/.test(key) ||
    /(^|_)TOKEN$/.test(key) ||
    /(^|_)SECRET$/.test(key) ||
    key.startsWith('AWS_') ||
    key.startsWith('GOOGLE_') ||
    key.startsWith('GCP_') ||
    key.startsWith('AZURE_') ||
    key.startsWith('OPENAI_') ||
    key.startsWith('ANTHROPIC_') ||
    key === 'GITHUB_TOKEN' ||
    key === 'SSH_AUTH_SOCK' ||
    key === 'SSH_AGENT_PID'
  );
}

export interface SandboxEnvironmentOptions {
  cwd?: string;
  readPolicy?: 'standard' | 'strict';
  tmpDir?: string;
  cacheDirectory?: string;
  dockerHostControl?: { socketPath: string; configDir: string };
}

export function createSandboxEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: SandboxEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    // Layer-1a backstop: redundant while the allowlist stays tiny; do not remove.
    // It is the last line of defense inside Layer 1 if a secret-shaped key is ever allowlisted.
    if (value === undefined || isSecretKey(key) || !isAllowedKey(key)) {
      continue;
    }
    env[key] = value;
  }

  if (options.tmpDir) env.TMPDIR = options.tmpDir;

  if (options.readPolicy === 'strict') {
    const cwd = options.cwd ?? getActiveWorkspaceRoot();
    const { config, cache, data, state } = resolveSandboxXdgLayout(cwd);
    env.XDG_CONFIG_HOME = config;
    env.XDG_CACHE_HOME = cache;
    env.XDG_DATA_HOME = data;
    env.XDG_STATE_HOME = state;
  }

  if (options.cacheDirectory) {
    env.XDG_CACHE_HOME = options.cacheDirectory;
    // npm uses a legacy home-relative cache rather than XDG_CACHE_HOME.
    env.npm_config_cache = path.join(options.cacheDirectory, 'npm');
    env.pnpm_config_store_dir = path.join(options.cacheDirectory, 'pnpm');
    env.PIP_CACHE_DIR = path.join(options.cacheDirectory, 'pip');
  }

  if (SANDBOX_SYSTEM_CA_BUNDLE) {
    env.SSL_CERT_FILE = SANDBOX_SYSTEM_CA_BUNDLE;
    env.PIP_CERT = SANDBOX_SYSTEM_CA_BUNDLE;
  }

  if (options.dockerHostControl) {
    env.DOCKER_HOST = `unix://${options.dockerHostControl.socketPath}`;
    env.DOCKER_CONFIG = options.dockerHostControl.configDir;
  }

  return env;
}
