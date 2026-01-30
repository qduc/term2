import test from 'ava';
import { getProvider } from '../registry.js';

// Import to trigger registration
import './github-copilot.provider.js';

test('github-copilot provider is registered', (t) => {
    const provider = getProvider('github-copilot');

    t.truthy(provider);
    t.is(provider!.id, 'github-copilot');
    t.is(provider!.label, 'GitHub Copilot');
});

test('github-copilot provider has createRunner function', (t) => {
    const provider = getProvider('github-copilot');

    t.truthy(provider);
    t.is(typeof provider!.createRunner, 'function');
});

test('github-copilot provider has fetchModels function', (t) => {
    const provider = getProvider('github-copilot');

    t.truthy(provider);
    t.is(typeof provider!.fetchModels, 'function');
});

test('github-copilot provider has empty sensitiveSettingKeys', (t) => {
    const provider = getProvider('github-copilot');

    t.truthy(provider);
    t.deepEqual(provider!.sensitiveSettingKeys, []);
});
