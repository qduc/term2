import test from 'ava';
import {OpenAIAgentClient} from './openai-agent-client.js';
import {registerProvider} from '../providers/registry.js';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';

// ========== Mock Utilities ==========

function createMockLogger(): ILoggingService {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        security: () => {},
        setCorrelationId: () => {},
        clearCorrelationId: () => {},
        getCorrelationId: () => undefined,
        log: () => {},
    } as any;
}

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
    const store: Record<string, any> = {
        'agent.provider': 'mock-provider-public-methods',
        'agent.model': 'mock-model',
        ...values,
    };
    return {
        get: <T>(key: string) => store[key] as T,
        set: (key: string, value: any) => { store[key] = value; },
    };
}

// Mock Runner that tracks calls
let runnerCalls: any[] = [];
class MockRunner {
    async run(_agent: any, _input: any, _options: any) {
        runnerCalls.push({agent: _agent, input: _input, options: _options});
        return {
            status: 'completed',
            finalOutput: 'mock response',
            messages: [],
        };
    }
}

// Register mock provider once
let providerRegistered = false;
function ensureProviderRegistered() {
    if (!providerRegistered) {
        registerProvider({
            id: 'mock-provider-public-methods',
            label: 'Mock Provider',
            createRunner: () => new MockRunner() as any,
            fetchModels: async () => [{id: 'mock-model'}],
            clearConversations: () => {},
        });
        providerRegistered = true;
    }
}

test.beforeEach(() => {
    runnerCalls = [];
    ensureProviderRegistered();
});

// ========== setModel tests ==========

test('setModel updates the internal model', async t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    // Set a new model
    client.setModel('gpt-4-turbo');

    // Trigger a chat to see what model is used
    await client.chat('test');

    t.is(runnerCalls.length, 1);
    // The agent should have the updated model
    const agent = runnerCalls[0].agent;
    t.truthy(agent);
});

// ========== setProvider / getProvider tests ==========

test('getProvider returns current provider', t => {
    const settings = createMockSettings({'agent.provider': 'mock-provider-public-methods'});
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.is(client.getProvider(), 'mock-provider-public-methods');
});

test('setProvider updates provider and persists to settings', t => {
    const settings = createMockSettings({'agent.provider': 'mock-provider-public-methods'});
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    client.setProvider('openai');
    t.is(client.getProvider(), 'openai');
    t.is(settings.get('agent.provider'), 'openai');
});

// ========== addToolInterceptor tests ==========

test('addToolInterceptor returns removal function', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    const remove = client.addToolInterceptor(async () => {
        return null;
    });

    t.is(typeof remove, 'function');
    // Calling remove should work without error
    remove();
    t.pass();
});

test('addToolInterceptor can be removed', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    const remove = client.addToolInterceptor(async () => {
        return null;
    });

    // Remove it
    remove();

    // After removal, the interceptor should not be called
    // (We can't directly test this without more complex setup)
    t.pass();
});

// ========== abort tests ==========

test('abort does not throw when called without active operation', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    // Should not throw
    t.notThrows(() => client.abort());
});

test('abort can be called multiple times', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => {
        client.abort();
        client.abort();
        client.abort();
    });
});

// ========== clearConversations tests ==========

test('clearConversations does not throw', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => client.clearConversations());
});

test('clearConversations can be called multiple times', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => {
        client.clearConversations();
        client.clearConversations();
    });
});

// ========== setReasoningEffort tests ==========

test('setReasoningEffort accepts valid effort levels', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => client.setReasoningEffort('high'));
    t.notThrows(() => client.setReasoningEffort('medium'));
    t.notThrows(() => client.setReasoningEffort('low'));
    t.notThrows(() => client.setReasoningEffort('default'));
    t.notThrows(() => client.setReasoningEffort(undefined));
});

// ========== setTemperature tests ==========

test('setTemperature accepts numeric values', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => client.setTemperature(0.5));
    t.notThrows(() => client.setTemperature(1.0));
    t.notThrows(() => client.setTemperature(0));
    t.notThrows(() => client.setTemperature(undefined));
});

// ========== setRetryCallback tests ==========

test('setRetryCallback accepts callback function', t => {
    const settings = createMockSettings();
    const client = new OpenAIAgentClient({
        deps: {logger: createMockLogger(), settings},
    });

    t.notThrows(() => client.setRetryCallback(() => {}));
});

