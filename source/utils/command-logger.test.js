import test from 'ava';
import {logCommandExecution} from '../../dist/utils/command-logger.js';

const buildSettingsService = (overrides = {}) => ({
    get: key => {
        switch (key) {
            case 'debug.debugBashTool':
                return true;
            case 'logging.suppressConsoleOutput':
                return true;
            case 'environment.nodeEnv':
                return 'test';
            default:
                return overrides[key];
        }
    },
});

test('logCommandExecution does not write to console when suppressed', t => {
    const originalConsoleError = console.error;
    const calls = [];

    console.error = (...args) => {
        calls.push(args);
    };

    try {
        logCommandExecution(
            buildSettingsService(),
            'echo hi',
            false,
            true,
        );

        t.is(calls.length, 0);
    } finally {
        console.error = originalConsoleError;
    }
});
