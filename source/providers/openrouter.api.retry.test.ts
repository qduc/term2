import test from 'ava';
import {callOpenRouter, OpenRouterError} from './openrouter/api.js';
import {createMockSettingsService} from '../services/settings-service.mock.js';

const mockSettingsService = createMockSettingsService({
	agent: {
		openrouter: {
			apiKey: 'mock-api-key',
		},
	},
});

test.serial('callOpenRouter retries once on 500 and then succeeds', async t => {
	let callCount = 0;
	const sleepCalls: number[] = [];

	const fetchImpl = async () => {
		callCount++;
		if (callCount === 1) {
			return new Response('{"error":{"message":"Internal Server Error","code":500}}', {
				status: 500,
				statusText: 'Internal Server Error',
				headers: {'Content-Type': 'application/json'},
			});
		}

		return new Response(
			JSON.stringify({
				id: 'resp-ok',
				choices: [{message: {content: 'ok'}}],
				usage: {},
			}),
			{status: 200, headers: {'Content-Type': 'application/json'}},
		);
	};

	const sleepImpl = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const res = await callOpenRouter({
		apiKey: 'k',
		model: 'm',
		messages: [],
		stream: false,
		settingsService: mockSettingsService,
		fetchImpl: fetchImpl as any,
		sleepImpl: sleepImpl as any,
		retry: {maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0},
	});

	t.is(res.status, 200);
	t.is(callCount, 2);
	t.deepEqual(sleepCalls, [0]);
});

test.serial('callOpenRouter does not retry on non-retryable 400', async t => {
	let callCount = 0;
	const sleepCalls: number[] = [];

	const fetchImpl = async () => {
		callCount++;
		return new Response('{"error":{"message":"Bad Request","code":400}}', {
			status: 400,
			statusText: 'Bad Request',
			headers: {'Content-Type': 'application/json'},
		});
	};

	const sleepImpl = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const err = await t.throwsAsync(
		() =>
			callOpenRouter({
				apiKey: 'k',
				model: 'm',
				messages: [],
				stream: false,
				settingsService: mockSettingsService,
				fetchImpl: fetchImpl as any,
				sleepImpl: sleepImpl as any,
				retry: {maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0},
			}),
		{instanceOf: OpenRouterError},
	);

	t.truthy(err);
	t.is(callCount, 1);
	t.deepEqual(sleepCalls, []);
});

test.serial('callOpenRouter respects Retry-After for 429', async t => {
	let callCount = 0;
	const sleepCalls: number[] = [];

	const fetchImpl = async () => {
		callCount++;
		if (callCount === 1) {
			return new Response('{"error":{"message":"Rate limited"}}', {
				status: 429,
				statusText: 'Too Many Requests',
				headers: {'Retry-After': '1', 'Content-Type': 'application/json'},
			});
		}
		return new Response(
			JSON.stringify({id: 'resp-ok', choices: [{message: {content: 'ok'}}], usage: {}}),
			{status: 200, headers: {'Content-Type': 'application/json'}},
		);
	};

	const sleepImpl = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const res = await callOpenRouter({
		apiKey: 'k',
		model: 'm',
		messages: [],
		stream: false,
		settingsService: mockSettingsService,
		fetchImpl: fetchImpl as any,
		sleepImpl: sleepImpl as any,
		retry: {maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0},
	});

	t.is(res.status, 200);
	t.is(callCount, 2);
	t.deepEqual(sleepCalls, [1000]);
});

test.serial('callOpenRouter retries once on network error and then succeeds', async t => {
	let callCount = 0;
	const sleepCalls: number[] = [];

	const fetchImpl = async () => {
		callCount++;
		if (callCount === 1) {
			throw new TypeError('fetch failed');
		}
		return new Response(
			JSON.stringify({id: 'resp-ok', choices: [{message: {content: 'ok'}}], usage: {}}),
			{status: 200, headers: {'Content-Type': 'application/json'}},
		);
	};

	const sleepImpl = async (ms: number) => {
		sleepCalls.push(ms);
	};

	const res = await callOpenRouter({
		apiKey: 'k',
		model: 'm',
		messages: [],
		stream: false,
		settingsService: mockSettingsService,
		fetchImpl: fetchImpl as any,
		sleepImpl: sleepImpl as any,
		retry: {maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0},
	});

	t.is(res.status, 200);
	t.is(callCount, 2);
	t.deepEqual(sleepCalls, [0]);
});
