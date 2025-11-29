import test from 'ava';
import {extractCommandMessages} from '../../dist/utils/extract-command-messages.js';

const withStubbedNow = value => {
	const realNow = Date.now;
	Date.now = () => value;
	return () => {
		Date.now = realNow;
	};
};

test('extracts bash command results from tool call output items', t => {
	const restore = withStubbedNow(1700000000000);

	try {
		const items = [
			{
				type: 'tool_call_output_item',
				output: '{"command":"date","output":"Mon Nov 24","success":true}',
				rawItem: {
					type: 'function_call_result',
					name: 'bash',
				},
			},
		];
		const messages = extractCommandMessages(items);

		t.is(messages.length, 1);
		t.deepEqual(messages[0], {
			id: '1700000000000-0',
			sender: 'command',
			command: 'date',
			output: 'Mon Nov 24',
			success: true,
		});
	} finally {
		restore();
	}
});

test('extracts commands from history function_call_result items', t => {
	const restore = withStubbedNow(1700000000100);

	try {
		const items = [
			{
				type: 'function_call_result',
				name: 'bash',
				output: {
					type: 'text',
					text: '{"command":"ls","output":"agent.js\\napp.js","success":false}',
				},
			},
		];
		const messages = extractCommandMessages(items);

		t.is(messages.length, 1);
		t.deepEqual(messages[0], {
			id: '1700000000100-0',
			sender: 'command',
			command: 'ls',
			output: 'agent.js\napp.js',
			success: false,
		});
	} finally {
		restore();
	}
});

test('extracts failure reason from shell command outcome', t => {
	const restore = withStubbedNow(1700000000200);

	try {
		const items = [
			{
				type: 'tool_call_output_item',
				output: JSON.stringify({
					output: [
						{
							command: 'rg -n "DEFAULT_TRIM_CONFIG"',
							stdout: '',
							stderr: '',
							outcome: {
								type: 'timeout',
							},
						},
					],
				}),
				rawItem: {
					type: 'function_call_result',
					name: 'shell',
				},
			},
		];
		const messages = extractCommandMessages(items);

		t.is(messages.length, 1);
		t.deepEqual(messages[0], {
			id: '1700000000200-0-0',
			sender: 'command',
			command: 'rg -n "DEFAULT_TRIM_CONFIG"',
			output: 'No output',
			success: false,
			failureReason: 'timeout',
		});
	} finally {
		restore();
	}
});
