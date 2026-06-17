import { it, expect } from 'vitest';
import { analyzePathRisk } from './command-safety/path-analysis.js';
import { SafetyStatus } from './command-safety/index.js';

// ============================================================================
// GREEN: Safe JSON files - common project configuration
// ============================================================================

it('JSON files - safe project config files (GREEN)', () => {
  const safePaths = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'jsconfig.json',
    'eslint.config.json',
    '.eslintrc.json',
    'prettier.config.json',
    '.prettierrc.json',
    'jest.config.json',
    'babel.config.json',
    '.babelrc.json',
    'ava.config.json',
    'xo.config.json',
    'tslint.json',
    'renovate.json',
    'nx.json',
    'project.json',
    'vercel.json',
    'now.json',
    'composer.json',
  ];

  for (const path of safePaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('JSON files - safe project configs with paths (GREEN)', () => {
  const safePaths = ['./package.json', 'src/tsconfig.json', 'packages/app/package.json', 'config/jest.config.json'];

  for (const path of safePaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('JSON files - regular unrecognized JSON files (GREEN)', () => {
  const regularPaths = [
    'data.json',
    'config.json',
    'output.json',
    'results.json',
    'response.json',
    'users.json',
    'items.json',
    './output/results.json',
    'src/data/fixtures.json',
  ];

  for (const path of regularPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be GREEN (permissive for unrecognized JSON)`).toBe(SafetyStatus.GREEN);
  }
});

// ============================================================================
// YELLOW: Suspicious JSON files - credentials and secrets
// ============================================================================

it('JSON files - explicit secrets and credentials (YELLOW)', () => {
  const suspiciousPaths = [
    'secrets.json',
    'secret.json',
    'credentials.json',
    'credential.json',
    'secret-prod.json',
    'credentials-prod.json',
    'secrets_production.json',
    'api-keys.json',
    'apikey.json',
    'api_key.json',
    'tokens.json',
    'token.json',
    'auth.json',
    'auth-tokens.json',
  ];

  for (const path of suspiciousPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - cloud provider credentials (YELLOW)', () => {
  const cloudCredPaths = [
    'firebase-adminsdk-abc123.json',
    'firebase-adminsdk.json',
    'google-credentials.json',
    'google-credentials-prod.json',
    'gcloud-service-account.json',
    'gcloud-keys.json',
    'azure-credentials.json',
    'azure-prod.json',
    'aws-prod-credentials.json',
    'aws-keys.json',
    'service-account.json',
    'service_account.json',
    'serviceAccount.json',
    'client_secret.json',
    'client-secret.json',
    'oauth-client.json',
    'oauth2-client.json',
  ];

  for (const path of cloudCredPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - private keys and keystores (YELLOW)', () => {
  const keyPaths = [
    'private.json',
    'private-key.json',
    'key.json',
    'key-prod.json',
    'id_rsa.json',
    'id_rsa_backup.json',
    'myapp.keystore.json',
    'app.keypair.json',
    'cert.p8.json',
    'cert.p12.json',
  ];

  for (const path of keyPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - SSO and authentication providers (YELLOW)', () => {
  const ssoPaths = [
    'okta-config.json',
    'okta-credentials.json',
    'sso-config.json',
    'sso-keys.json',
    'saml-config.json',
    'saml-credentials.json',
  ];

  for (const path of ssoPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - monitoring service credentials (YELLOW)', () => {
  const monitoringPaths = [
    'sentry-config.json',
    'sentry-dsn.json',
    'newrelic-config.json',
    'newrelic-license.json',
    'datadog-keys.json',
    'datadog-api.json',
  ];

  for (const path of monitoringPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - vault and secret management (YELLOW)', () => {
  const vaultPaths = ['vault-keys.json', 'vault-config.json', 'vault-tokens.json'];

  for (const path of vaultPaths) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - case insensitive matching (YELLOW)', () => {
  const caseVariations = [
    'Secrets.json',
    'SECRETS.JSON',
    'Credentials.JSON',
    'GOOGLE-CREDENTIALS.json',
    'Firebase-AdminSDK.json',
    'API-KEYS.JSON',
  ];

  for (const path of caseVariations) {
    const result = analyzePathRisk(path);
    expect(result, `"${path}" should be YELLOW (case insensitive)`).toBe(SafetyStatus.YELLOW);
  }
});

it('JSON files - suspicious files with paths (YELLOW)', () => {
  const pathsWithDirs = [
    './secrets.json',
    'config/credentials.json',
    'src/auth/service-account.json',
    '../credentials.json',
  ];

  for (const path of pathsWithDirs) {
    // Note: '../credentials.json' will be RED due to directory traversal,
    // but we're testing that the JSON pattern matching still applies
    const result = analyzePathRisk(path);
    expect(result === SafetyStatus.YELLOW || result === SafetyStatus.RED).toBe(true);
  }
});

// ============================================================================
// YELLOW: Other sensitive extensions (non-JSON)
// ============================================================================

it('Sensitive extensions - env, pem, key files (YELLOW)', () => {
  const sensitivePaths = [
    '.env',
    '.env.local',
    'production.env',
    'private.key',
    'certificate.pem',
    'id_rsa.pem',
    'app.key',
  ];

  for (const path of sensitivePaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

// ============================================================================
// Edge Cases and False Positives
// ============================================================================

it('JSON files - avoid false positives in safe filenames (GREEN)', () => {
  // Files that contain words like "secret" or "key" but are clearly safe configs
  const falsPositives = ['webpack.config.json', 'typescript.json', 'settings.json', 'manifest.json', 'launch.json'];

  for (const path of falsPositives) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.GREEN);
  }
});

it('JSON files - files ending with .json extension only (GREEN)', () => {
  // Make sure we only match .json extension, not similar patterns
  const edgeCases = ['test.json', 'output.json', 'data.json'];

  for (const path of edgeCases) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.GREEN);
  }
});

// ============================================================================
// RED: Sensitive home paths
// ============================================================================

it('Path risk - directory traversal (YELLOW)', () => {
  const traversalPaths = [
    '../secrets.json',
    '../../.env',
    '../../../etc/passwd',
    './../../package.json', // Even safe files with traversal
  ];

  for (const path of traversalPaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - home directory paths (RED)', () => {
  const homePaths = [
    '~/.aws/credentials',
    '~/secrets.json',
    '$HOME/.env',
    '/home/user/.ssh/id_rsa',
    '/Users/alice/.kube/config',
  ];

  for (const path of homePaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.RED);
  }
});

it('Path risk - absolute system paths (YELLOW)', () => {
  const systemPaths = ['/etc/passwd', '/var/log/system.log', '/usr/bin/node', '/boot/grub/grub.cfg'];

  for (const path of systemPaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - hidden files (YELLOW)', () => {
  const hiddenPaths = ['.hidden', '.secret', '.config', 'src/.hidden-file'];

  for (const path of hiddenPaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - sensitive hidden directories inside project (YELLOW)', () => {
  const sensitivePaths = [
    '.ssh/id_rsa',
    'src/.aws/credentials',
    'config/.kube/config',
    '.env/production',
    '.git/config',
    '.gnupg/private-keys-v1.d/key',
  ];

  for (const path of sensitivePaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - empty or undefined paths (GREEN)', () => {
  const emptyPaths = [undefined, '', '   '];

  for (const path of emptyPaths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.GREEN);
  }
});

// ============================================================================
// NEW: Absolute paths within current project should be treated as local paths
// ============================================================================

it('Path risk - absolute paths within project (GREEN for safe files)', () => {
  const cwd = process.cwd();
  // These are safe files that should be GREEN when referenced with absolute paths within project
  const paths = [
    `${cwd}/package.json`,
    `${cwd}/source/main.ts`,
    `${cwd}/src/utils/helper.js`,
    `${cwd}/config/settings.json`,
  ];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.GREEN);
  }
});

it('Path risk - absolute paths within project (YELLOW for hidden files)', () => {
  const cwd = process.cwd();
  // Hidden files should still be YELLOW even within project
  const paths = [`${cwd}/.env`, `${cwd}/src/.hidden`];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - absolute paths within project (YELLOW for sensitive extensions)', () => {
  const cwd = process.cwd();
  // Sensitive extensions are still YELLOW even within project
  const paths = [`${cwd}/.env`, `${cwd}/key.pem`, `${cwd}/cert.key`];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - absolute paths outside project (YELLOW)', () => {
  const paths = ['/opt/app.log', '/home/other/file.txt'];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - absolute paths under temporary directory (GREEN for safe files)', () => {
  const paths = ['/tmp/test.txt', '/private/tmp/test.txt', '/tmp/sub/dir/file.log'];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.GREEN);
  }
});

it('Path risk - absolute paths under temporary directory (YELLOW for hidden/sensitive files)', () => {
  const paths = ['/tmp/.env', '/tmp/secret.pem', '/tmp/.hidden'];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('Path risk - absolute system paths remain YELLOW regardless of project', () => {
  const paths = ['/etc/passwd', '/var/log/system.log', '/usr/bin/node'];

  for (const path of paths) {
    const result = analyzePathRisk(path);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});
