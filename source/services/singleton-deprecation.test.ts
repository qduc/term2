import test from 'ava';
import {settingsService} from './settings-service.js';
import {loggingService} from './logging-service.js';

/**
 * These tests verify that the singleton deprecation works correctly.
 *
 * The singletons are wrapped in Proxies that:
 * - Allow access in test environments (detected via env variables)
 * - Throw helpful errors in production to catch deprecated usage
 *
 * Note: We can't easily test the error-throwing behavior in these tests
 * because we're running in a test environment. The deprecation errors
 * will be caught at runtime when the app runs outside of tests.
 */

test('settingsService works in test environment', t => {
    // This test runs in test environment - should work without throwing
    t.notThrows(() => {
        const model = settingsService.get('agent.model');
        t.is(typeof model, 'string');
    });

    t.notThrows(() => {
        const source = settingsService.getSource('agent.model');
        t.is(typeof source, 'string');
    });
});

test('loggingService works in test environment', t => {
    // This test runs in test environment - should work without throwing
    t.notThrows(() => {
        loggingService.info('test message from singleton deprecation test');
    });

    t.notThrows(() => {
        loggingService.debug('debug message');
    });
});

test('settingsService has deprecation documentation', async t => {
    // Read the source file to verify documentation exists
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const filePath = path.join(__dirname, '../../source/services/settings-service.ts');

    const content = await fs.readFile(filePath, 'utf-8');

    t.true(content.includes('@deprecated DO NOT USE'));
    t.true(content.includes('dependency injection'));
    t.true(content.includes('DEPRECATED: Direct use of settingsService singleton'));
});

test('loggingService has deprecation documentation', async t => {
    // Read the source file to verify documentation exists
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const filePath = path.join(__dirname, '../../source/services/logging-service.ts');

    const content = await fs.readFile(filePath, 'utf-8');

    t.true(content.includes('@deprecated DO NOT USE'));
    t.true(content.includes('dependency injection'));
    t.true(content.includes('DEPRECATED: Direct use of loggingService singleton'));
});
