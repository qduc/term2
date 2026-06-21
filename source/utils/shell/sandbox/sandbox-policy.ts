import os from 'node:os';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

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
      signal?: AbortSignal;
    },
  ): Promise<{ command: string; diagnostics?: string[] }>;
  annotateFailure(command: string, stderr: string): string;
}

export function createSandboxRuntimeConfig(cwd: string): SandboxRuntimeConfig {
  const workspace = path.resolve(cwd);
  const home = os.homedir();
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
  ];
  const credentialEnvVars = [
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

  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: credentialFiles,
      allowWrite: [workspace],
      denyWrite: [],
      allowGitConfig: false,
    },
    credentials: {
      files: credentialFiles.map((filePath) => ({ path: filePath, mode: 'deny' as const })),
      envVars: credentialEnvVars.map((name) => ({ name, mode: 'deny' as const })),
    },
  };
}

export const SANDBOX_ESCAPE_INSTRUCTION =
  'Sandbox blocked this command. To request a one-shot escape, call shell again with sandbox="unsandboxed"; user approval will be required.';
