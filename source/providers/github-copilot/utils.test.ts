import test from 'ava';
import {
    isCopilotCliAvailable,
    isGhAuthenticated,
    isCopilotCliAvailableAsync,
    isGhAuthenticatedAsync,
} from './utils.js';

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

test('isCopilotCliAvailableAsync - returns Promise<boolean>', async (t) => {
    const result = await isCopilotCliAvailableAsync();
    t.is(typeof result, 'boolean');
});

test('isGhAuthenticatedAsync - returns Promise<boolean>', async (t) => {
    const result = await isGhAuthenticatedAsync();
    t.is(typeof result, 'boolean');
});
