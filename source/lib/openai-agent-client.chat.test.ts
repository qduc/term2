import test from 'ava';
import {OpenAIAgentClient} from './openai-agent-client.js';
import {registerProvider} from '../providers/registry.js';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';

// Mock Logger
const mockLogger: ILoggingService = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    log: () => {},
} as any;

// Mock Settings
const mockSettings: ISettingsService = {
    get: (key: string) => {
        if (key === 'agent.provider') return 'mock-provider-chat';
        if (key === 'agent.model') return 'mock-model';
        return undefined;
    },
    set: () => {},
    onChange: () => {},
} as any;

// Mock Runner
class MockRunner {
    async run(_agent: any, _input: any, _options: any) {
        return {
            status: 'completed',
            messages: [{role: 'assistant', content: 'Fallback content'}],
            // finalOutput is missing
        };
    }
}

test.before(() => {
    registerProvider({
        id: 'mock-provider-chat',
        label: 'Mock Provider Chat',
        createRunner: () => new MockRunner() as any,
        fetchModels: async () => [{id: 'mock-model'}],
    });
});

test('OpenAIAgentClient.chat falls back to messages if finalOutput is missing', async t => {
    const client = new OpenAIAgentClient({
        deps: {
            logger: mockLogger,
            settings: mockSettings,
        },
    });

    const response = await client.chat('Hello');
    t.is(response, 'Fallback content');
});
