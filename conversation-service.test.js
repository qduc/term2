import test from 'ava';
import {ConversationService} from './source/services/conversation-service.js';

class MockStream {
	constructor(events) {
		this.events = events;
		this.completed = Promise.resolve();
		this.lastResponseId = 'resp_test';
		this.interruptions = [];
		this.state = {};
		this.newItems = [];
		this.history = [];
		this.finalOutput = '';
	}

	async *[Symbol.asyncIterator]() {
		for (const event of this.events) {
			yield event;
		}
	}
}

test('emits live text chunks for response.output_text.delta events', async t => {
	t.plan(3);

	const events = [
		{type: 'response.output_text.delta', delta: 'Hello'},
		{type: 'response.output_text.delta', delta: ' world'},
	];

	const mockClient = {
		async startStream() {
			return new MockStream(events);
		},
	};

	const chunks = [];
	const service = new ConversationService({agentClient: mockClient});
	const result = await service.sendMessage('hi', {
		onTextChunk(full, chunk) {
			chunks.push({full, chunk});
		},
	});

	t.deepEqual(chunks, [
		{full: 'Hello', chunk: 'Hello'},
		{full: 'Hello world', chunk: ' world'},
	]);
	t.is(result.type, 'response');
	t.is(result.finalText, 'Hello world');
});
