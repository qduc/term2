import test from 'ava';
import {extractCommandMessages} from '../../dist/utils/extract-command-messages.js';

const withStubbedNow = value => {
    const realNow = Date.now;
    Date.now = () => value;
    return () => {
        Date.now = realNow;
    };
};

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
