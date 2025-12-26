import test from 'ava';
import {analyzePathRisk} from './command-safety/path-analysis.js';
import {SafetyStatus} from './command-safety/index.js';

// ============================================================================
// GREEN: Safe JSON files - common project configuration
// ============================================================================

test('JSON files - safe project config files (GREEN)', t => {
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
        t.is(result, SafetyStatus.GREEN, `"${path}" should be GREEN`);
    }
});

test('JSON files - safe project configs with paths (GREEN)', t => {
    const safePaths = [
        './package.json',
        'src/tsconfig.json',
        'packages/app/package.json',
        'config/jest.config.json',
    ];

    for (const path of safePaths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.GREEN, `"${path}" should be GREEN`);
    }
});

test('JSON files - regular unrecognized JSON files (GREEN)', t => {
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
        t.is(
            result,
            SafetyStatus.GREEN,
            `"${path}" should be GREEN (permissive for unrecognized JSON)`,
        );
    }
});

// ============================================================================
// YELLOW: Suspicious JSON files - credentials and secrets
// ============================================================================

test('JSON files - explicit secrets and credentials (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - cloud provider credentials (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - private keys and keystores (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - SSO and authentication providers (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - monitoring service credentials (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - vault and secret management (YELLOW)', t => {
    const vaultPaths = [
        'vault-keys.json',
        'vault-config.json',
        'vault-tokens.json',
    ];

    for (const path of vaultPaths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

test('JSON files - case insensitive matching (YELLOW)', t => {
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
        t.is(
            result,
            SafetyStatus.YELLOW,
            `"${path}" should be YELLOW (case insensitive)`,
        );
    }
});

test('JSON files - suspicious files with paths (YELLOW)', t => {
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
        t.true(
            result === SafetyStatus.YELLOW || result === SafetyStatus.RED,
            `"${path}" should be at least YELLOW`,
        );
    }
});

// ============================================================================
// YELLOW: Other sensitive extensions (non-JSON)
// ============================================================================

test('Sensitive extensions - env, pem, key files (YELLOW)', t => {
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
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW`);
    }
});

// ============================================================================
// Edge Cases and False Positives
// ============================================================================

test('JSON files - avoid false positives in safe filenames (GREEN)', t => {
    // Files that contain words like "secret" or "key" but are clearly safe configs
    const falsPositives = [
        'webpack.config.json',
        'typescript.json',
        'settings.json',
        'manifest.json',
        'launch.json',
    ];

    for (const path of falsPositives) {
        const result = analyzePathRisk(path);
        t.is(
            result,
            SafetyStatus.GREEN,
            `"${path}" should be GREEN (false positive avoidance)`,
        );
    }
});

test('JSON files - files ending with .json extension only (GREEN)', t => {
    // Make sure we only match .json extension, not similar patterns
    const edgeCases = ['test.json', 'output.json', 'data.json'];

    for (const path of edgeCases) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.GREEN, `"${path}" should be GREEN`);
    }
});

// ============================================================================
// RED: Directory traversal, home directories, system paths
// ============================================================================

test('Path risk - directory traversal (RED)', t => {
    const traversalPaths = [
        '../secrets.json',
        '../../.env',
        '../../../etc/passwd',
        './../../package.json', // Even safe files with traversal
    ];

    for (const path of traversalPaths) {
        const result = analyzePathRisk(path);
        t.is(
            result,
            SafetyStatus.RED,
            `"${path}" should be RED (directory traversal)`,
        );
    }
});

test('Path risk - home directory paths (RED)', t => {
    const homePaths = [
        '~/.aws/credentials',
        '~/secrets.json',
        '$HOME/.env',
        '/home/user/.ssh/id_rsa',
        '/Users/alice/.kube/config',
    ];

    for (const path of homePaths) {
        const result = analyzePathRisk(path);
        t.is(
            result,
            SafetyStatus.RED,
            `"${path}" should be RED (home directory)`,
        );
    }
});

test('Path risk - absolute system paths (RED)', t => {
    const systemPaths = [
        '/etc/passwd',
        '/var/log/system.log',
        '/usr/bin/node',
        '/boot/grub/grub.cfg',
    ];

    for (const path of systemPaths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.RED, `"${path}" should be RED (system path)`);
    }
});

test('Path risk - hidden files (YELLOW)', t => {
    const hiddenPaths = ['.hidden', '.secret', '.config', 'src/.hidden-file'];

    for (const path of hiddenPaths) {
        const result = analyzePathRisk(path);
        t.is(
            result,
            SafetyStatus.YELLOW,
            `"${path}" should be YELLOW (hidden file)`,
        );
    }
});

test('Path risk - empty or undefined paths (GREEN)', t => {
    const emptyPaths = [undefined, '', '   '];

    for (const path of emptyPaths) {
        const result = analyzePathRisk(path);
        t.is(
            result,
            SafetyStatus.GREEN,
            `"${path}" should be GREEN (empty/undefined)`,
        );
    }
});

// ============================================================================
// NEW: Absolute paths within current project should be treated as local paths
// ============================================================================

test('Path risk - absolute paths within project (GREEN for safe files)', t => {
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
        t.is(result, SafetyStatus.GREEN, `"${path}" should be GREEN (safe file within project)`);
    }
});

test('Path risk - absolute paths within project (YELLOW for hidden files)', t => {
    const cwd = process.cwd();
    // Hidden files should still be YELLOW even within project
    const paths = [
        `${cwd}/.env`,
        `${cwd}/src/.hidden`,
    ];

    for (const path of paths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW (hidden file within project)`);
    }
});

test('Path risk - absolute paths within project (YELLOW for sensitive extensions)', t => {
    const cwd = process.cwd();
    // Sensitive extensions are still YELLOW even within project
    const paths = [
        `${cwd}/.env`,
        `${cwd}/key.pem`,
        `${cwd}/cert.key`,
    ];

    for (const path of paths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW (sensitive extension within project)`);
    }
});

test('Path risk - absolute paths outside project (YELLOW)', t => {
    const paths = [
        '/tmp/test.txt',
        '/opt/app.log',
        '/home/other/file.txt',
    ];

    for (const path of paths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.YELLOW, `"${path}" should be YELLOW (outside project)`);
    }
});

test('Path risk - absolute system paths still RED regardless of project', t => {
    const paths = [
        '/etc/passwd',
        '/var/log/system.log',
        '/usr/bin/node',
    ];

    for (const path of paths) {
        const result = analyzePathRisk(path);
        t.is(result, SafetyStatus.RED, `"${path}" should be RED (system path)`);
    }
});
