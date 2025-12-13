import test from 'ava';
import type {AgentInputItem} from '@openai/agents';
import {ConversationStore} from './conversation-store.js';

test('addUserMessage() appends a user message item', t => {
	const store = new ConversationStore();
	store.addUserMessage('Hello');

	const history = store.getHistory();
	t.is(history.length, 1);
	const item: any = history[0];
	t.is(item.role, 'user');
	t.is(item.type, 'message');
	t.is(item.content, 'Hello');
});

test('getHistory() returns a copy (external mutation does not affect store)', t => {
	const store = new ConversationStore();
	store.addUserMessage('A');

	const history1 = store.getHistory();
	history1.push({role: 'assistant', type: 'message', content: 'Injected'} as AgentInputItem);

	const history2 = store.getHistory();
	t.is(history2.length, 1);
	const item: any = history2[0];
	t.is(item.content, 'A');
});

test('getLastUserMessage() returns the most recent user message text', t => {
	const store = new ConversationStore();
	store.addUserMessage('First');
	store.addUserMessage('Second');

	t.is(store.getLastUserMessage(), 'Second');
});

test('updateFromResult() merges run history without duplicating overlap', t => {
	const store = new ConversationStore();
	store.addUserMessage('Hi');

	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'Hi'},
			{role: 'assistant', type: 'message', content: 'Hello!'},
		] satisfies AgentInputItem[],
	});

	let history = store.getHistory();
	t.is(history.length, 2);
	let last: any = history[history.length - 1];
	t.is(last.role, 'assistant');
	t.is(last.content, 'Hello!');

	// Next turn: user message is already in store; incoming history contains it too.
	store.addUserMessage('How are you?');
	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'How are you?'},
			{role: 'assistant', type: 'message', content: 'Doing great.'},
		] satisfies AgentInputItem[],
	});

	history = store.getHistory();
	t.is(history.length, 4);
	last = history[history.length - 1];
	t.is(last.role, 'assistant');
	t.is(last.content, 'Doing great.');
});

test('updateFromResult() replaces history when incoming history is a superset', t => {
	const store = new ConversationStore();
	store.addUserMessage('One');
	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'One'},
			{role: 'assistant', type: 'message', content: 'Ack'},
		] satisfies AgentInputItem[],
	});

	store.addUserMessage('Two');
	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'One'},
			{role: 'assistant', type: 'message', content: 'Ack'},
			{role: 'user', type: 'message', content: 'Two'},
			{role: 'assistant', type: 'message', content: 'Ack2'},
		] satisfies AgentInputItem[],
	});

	const history = store.getHistory();
	t.is(history.length, 4);
	const last: any = history[3];
	t.is(last.content, 'Ack2');
});

test('updateFromResult() preserves reasoning_details across overlap merges', t => {
	const store = new ConversationStore();

	// Initial transcript where the assistant message has no reasoning_details.
	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'First'},
			{role: 'assistant', type: 'message', content: 'Hello'},
		] satisfies AgentInputItem[],
	});

	// Later, the SDK returns incremental history starting with the last assistant
	// message, now enriched with reasoning_details (common in tool flows).
	const reasoning_details = [{type: 'text', text: 'thinking'}];
	store.updateFromResult({
		history: [
			{role: 'assistant', type: 'message', content: 'Hello', reasoning_details},
			{type: 'function_call', id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}'},
			{type: 'function_call_result', callId: 'call-1', output: 'files\n'},
		] as any,
	});

	const history: any[] = store.getHistory() as any;
	const assistantHello = history.find(
		item => (item?.rawItem ?? item)?.role === 'assistant' && (item?.rawItem ?? item)?.content === 'Hello',
	);
	t.truthy(assistantHello);
	t.deepEqual((assistantHello?.rawItem ?? assistantHello)?.reasoning_details, reasoning_details);
});

test('updateFromResult() preserves reasoning (reasoning tokens) across overlap merges', t => {
	const store = new ConversationStore();

	// Initial transcript where the assistant message has no reasoning field.
	store.updateFromResult({
		history: [
			{role: 'user', type: 'message', content: 'First'},
			{role: 'assistant', type: 'message', content: 'Hello'},
		] satisfies AgentInputItem[],
	});

	// Later, the SDK returns incremental history starting with the last assistant
	// message, now enriched with OpenRouter-style reasoning.
	store.updateFromResult({
		history: [
			{role: 'assistant', type: 'message', content: 'Hello', reasoning: 'Some hidden thinking'},
			{role: 'user', type: 'message', content: 'Next'},
		] as any,
	});

	const history: any[] = store.getHistory() as any;
	const assistantHello = history.find(
		item =>
			(item?.rawItem ?? item)?.role === 'assistant' &&
			(item?.rawItem ?? item)?.content === 'Hello',
	);
	t.truthy(assistantHello);
	t.is((assistantHello?.rawItem ?? assistantHello)?.reasoning, 'Some hidden thinking');
});

test('clear() resets history', t => {
	const store = new ConversationStore();
	store.addUserMessage('Hello');
	t.is(store.getHistory().length, 1);

	store.clear();
	t.is(store.getHistory().length, 0);
	t.is(store.getLastUserMessage(), '');
});
