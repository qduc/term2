const ALLOWED_EXACT_KEYS = new Set(['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'HOME']);

function isAllowedKey(key: string): boolean {
  return ALLOWED_EXACT_KEYS.has(key) || key === 'LANG' || key.startsWith('LC_');
}

function isSecretKey(key: string): boolean {
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

export function createSandboxEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isSecretKey(key) || !isAllowedKey(key)) {
      continue;
    }
    env[key] = value;
  }

  return env;
}
