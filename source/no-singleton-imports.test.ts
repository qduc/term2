import test from 'ava';
import fg from 'fast-glob';
import {readFile} from 'node:fs/promises';

/**
 * Guardrail: the deprecated singleton proxies (settingsService/loggingService/historyService)
 * must not be imported in non-test source files.
 *
 * Why: they throw at runtime outside test env, and they hide dependencies.
 */

test('no non-test files import deprecated singletons', async t => {
    const files = await fg(['source/**/*.{ts,tsx,js,jsx}'], {
        ignore: [
            'source/**/*.test.*',
            // snapshot folders etc (if any)
            'source/**/__snapshots__/**',
        ],
        dot: false,
    });

    const forbiddenImportRe =
        /import\s*\{\s*(settingsService|loggingService|historyService)\s*\}\s*from\s*['"][^'"]*(settings-service|logging-service|history-service)\.js['"]/g;

    const offenders: Array<{file: string; matches: string[]}> = [];

    for (const file of files) {
        const content = await readFile(file, 'utf8');
        const matches = Array.from(content.matchAll(forbiddenImportRe)).map(
            m => m[0],
        );
        if (matches.length > 0) {
            offenders.push({file, matches});
        }
    }

    t.deepEqual(offenders, []);
});
