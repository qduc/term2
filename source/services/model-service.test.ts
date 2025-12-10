import test from 'ava';
import {
	fetchModels,
	clearModelCache,
	filterModels,
} from './model-service.js';
import {settingsService} from './settings-service.js';

const originalProvider = settingsService.get('agent.provider');
const originalApiKey = process.env.OPENAI_API_KEY;

test.afterEach(() => {
	clearModelCache();
	settingsService.set('agent.provider', originalProvider);
	process.env.OPENAI_API_KEY = originalApiKey;
});

test('fetchModels uses OpenRouter endpoint and caches results', async t => {
	settingsService.set('agent.provider', 'openrouter');
	const calls: Array<{url: string; options: any}> = [];
	const fakeFetch = async (url: string, options: any) => {
		calls.push({url, options});
		return {
			ok: true,
			json: async () => ({
				data: [
					{id: 'openrouter/model-a', name: 'Model A', supported_parameters: ['tools', 'temperature']},
					{id: 'openrouter/model-b', name: 'Model B', supported_parameters: ['temperature']},
					{id: 'openrouter/model-c', name: 'Model C', supported_parameters: ['tools', 'max_tokens']},
				],
			}),
		};
	};

	const first = await fetchModels(undefined, fakeFetch as any);
	const second = await fetchModels(undefined, fakeFetch as any);

	t.deepEqual(first.map(m => m.id), ['openrouter/model-a', 'openrouter/model-c']);
	t.is(second.length, first.length, 'Cache should be reused');
	// Only the first call should hit fetch because of caching
	t.is(calls.length, 1);
	t.true(calls[0].url.includes('/models'));
});

test('fetchModels uses OpenAI models endpoint when provider is openai', async t => {
	settingsService.set('agent.provider', 'openai');
	process.env.OPENAI_API_KEY = 'key-openai-test';
	const calls: Array<{url: string; options: any}> = [];

	const fakeFetch = async (url: string, options: any) => {
		calls.push({url, options});
		return {
			ok: true,
			json: async () => ({data: [{id: 'gpt-4o'}, {id: 'gpt-4.1'}]}),
		};
	};

	const models = await fetchModels(undefined, fakeFetch as any);

	t.deepEqual(models.map(m => m.id), ['gpt-4o', 'gpt-4.1']);
	t.is(calls.length, 1);
	t.is(calls[0].url, 'https://api.openai.com/v1/models');
	// Should include Authorization header when API key present
	t.truthy(calls[0].options?.headers?.Authorization);
});

test('filterModels matches by id or name and limits results', t => {
	const models = [
		{id: 'gpt-4o', name: 'OpenAI 4o', provider: 'openai' as const},
		{id: 'gpt-4.1', name: 'Reasoning', provider: 'openai' as const},
		{id: 'meta/llama-3', name: 'Llama 3', provider: 'openrouter' as const},
		{id: 'mistral-large', name: 'Mistral Large', provider: 'openrouter' as const},
	];

	const top = filterModels(models, 'llama');
	t.deepEqual(top.map(m => m.id), ['meta/llama-3']);

	const fuzzy = filterModels(models, 'gpt');
	t.is(fuzzy.length, 2);
	// Max results should cap list
	const limited = filterModels(models, '');
	t.is(limited.length, 2);
});
