import test from 'ava';
import { GitHubCopilotProvider, createGitHubCopilotProvider } from './provider.js';
import type { ISettingsService, ILoggingService } from '../../services/service-interfaces.js';

// Mock services
const mockSettingsService: ISettingsService = {
    get: <T>(key: string): T => {
        if (key === 'agent.model') return 'gpt-4o' as T;
        if (key === 'agent.github-copilot.model') return 'gpt-4o' as T;
        return undefined as T;
    },
    set: () => {},
};

const mockLoggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
};

test('GitHubCopilotProvider - getModel returns GitHubCopilotModel', async (t) => {
    const provider = new GitHubCopilotProvider({
        settingsService: mockSettingsService,
        loggingService: mockLoggingService,
    });

    const model = await provider.getModel();

    t.truthy(model);
    // Check that it's our model by verifying the name property we add
    t.is((model as any).name, 'GitHubCopilot');
});

test('GitHubCopilotProvider - getModel accepts model override', async (t) => {
    const provider = new GitHubCopilotProvider({
        settingsService: mockSettingsService,
        loggingService: mockLoggingService,
    });

    const model = await provider.getModel('claude-3.5-sonnet');

    t.truthy(model);
    // Check that it's our model by verifying the name property we add
    t.is((model as any).name, 'GitHubCopilot');
});

test('createGitHubCopilotProvider - factory function works', (t) => {
    const provider = createGitHubCopilotProvider({
        settingsService: mockSettingsService,
        loggingService: mockLoggingService,
    });

    t.truthy(provider);
    t.true(provider instanceof GitHubCopilotProvider);
});
