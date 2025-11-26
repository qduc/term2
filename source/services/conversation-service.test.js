import test from 'ava';
import {ConversationService} from '../../dist/services/conversation-service.js';

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

test('passes previous response ids into subsequent runs', async t => {
	const streams = [new MockStream([]), new MockStream([])];
	streams[0].lastResponseId = 'resp-1';
	streams[0].finalOutput = 'First run done.';
	streams[1].lastResponseId = 'resp-2';
	streams[1].finalOutput = 'Second run done.';

	const startCalls = [];
	const mockClient = {
		async startStream(text, options) {
			const index = startCalls.length;
			startCalls.push({text, options});
			return streams[index];
		},
	};

	const service = new ConversationService({agentClient: mockClient});
	await service.sendMessage('first');
	const secondResult = await service.sendMessage('second');

	t.deepEqual(startCalls, [
		{text: 'first', options: {previousResponseId: null}},
		{text: 'second', options: {previousResponseId: 'resp-1'}},
	]);
	t.is(secondResult.type, 'response');
	t.is(secondResult.finalText, 'Second run done.');
});

test('emits approval interruptions and resumes after approval', async t => {
	const interruption = {
		name: 'bash',
		agent: {name: 'CLI Agent'},
		arguments: JSON.stringify({command: 'echo hi'}),
	};

	const initialStream = new MockStream([]);
	initialStream.interruptions = [interruption];
	initialStream.state = {
		approveCalls: [],
		rejectCalls: [],
		approve(arg) {
			this.approveCalls.push(arg);
		},
		reject(arg) {
			this.rejectCalls.push(arg);
		},
	};

	const continuationStream = new MockStream([
		{type: 'response.output_text.delta', delta: 'Approved run'},
	]);
	continuationStream.finalOutput = 'Approved run';

	const mockClient = {
		async startStream() {
			return initialStream;
		},
		async continueRunStream(state) {
			t.is(state, initialStream.state);
			return continuationStream;
		},
	};

	const service = new ConversationService({agentClient: mockClient});
	const approvalResult = await service.sendMessage('run command');
	t.is(approvalResult.type, 'approval_required');
	t.is(approvalResult.approval.toolName, 'bash');
	t.is(approvalResult.approval.argumentsText, 'echo hi');

	const finalResult = await service.handleApprovalDecision('y');
	t.truthy(finalResult);
	t.is(finalResult.type, 'response');
	t.is(finalResult.finalText, 'Approved run');
	t.deepEqual(initialStream.state.approveCalls, [interruption]);
	t.deepEqual(initialStream.state.rejectCalls, []);
});

test('dedupes command messages emitted live from run events', async t => {
	const commandPayload = JSON.stringify({
		command: 'ls',
		stdout: 'file.txt',
		success: true,
	});
	const rawItem = {
		id: 'call-123',
		type: 'function_call_result',
		name: 'bash',
		arguments: JSON.stringify({command: 'ls'}),
	};
	const commandItem = {
		type: 'tool_call_output_item',
		name: 'bash',
		output: commandPayload,
		rawItem,
	};
	const events = [{type: 'run_item_stream_event', item: commandItem}];
	const stream = new MockStream(events);
	stream.newItems = [commandItem];

	const emitted = [];
	const mockClient = {
		async startStream() {
			return stream;
		},
	};

	const service = new ConversationService({agentClient: mockClient});
	const result = await service.sendMessage('run bash', {
		onCommandMessage(message) {
			emitted.push(message);
		},
	});

	t.deepEqual(emitted, [
		{
			id: 'call-123',
			sender: 'command',
			command: 'ls',
			output: 'file.txt',
			success: true,
		},
	]);
	t.deepEqual(result.commandMessages, []);
});
