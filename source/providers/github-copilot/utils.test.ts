import test from 'ava';
import { isCopilotCliAvailable, isGhAuthenticated } from './utils.js';

// Note: These tests verify the function signatures work correctly.
// The actual behavior depends on the system state (whether gh CLI is installed).

test('isCopilotCliAvailable - returns boolean', (t) => {
    const result = isCopilotCliAvailable();
    t.is(typeof result, 'boolean');
});

test('isGhAuthenticated - returns boolean', (t) => {
    const result = isGhAuthenticated();
    t.is(typeof result, 'boolean');
});
