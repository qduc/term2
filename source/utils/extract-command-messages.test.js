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

test('extracts successful apply_patch create_file operation', t => {
    const restore = withStubbedNow(1700000000300);

    try {
        const items = [
            {
                type: 'tool_call_output_item',
                output: JSON.stringify({
                    output: [
                        {
                            success: true,
                            operation: 'create_file',
                            path: 'test.txt',
                            message: 'Created test.txt',
                        },
                    ],
                }),
                rawItem: {
                    type: 'function_call_result',
                    name: 'apply_patch',
                    arguments: {
                        type: 'create_file',
                        path: 'test.txt',
                    },
                },
            },
        ];
        const messages = extractCommandMessages(items);

        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: '1700000000300-0-0',
            sender: 'command',
            command: 'apply_patch create_file test.txt',
            output: 'Created test.txt',
            success: true,
        });
    } finally {
        restore();
    }
});

test('extracts successful apply_patch update_file operation', t => {
    const restore = withStubbedNow(1700000000400);

    try {
        const items = [
            {
                type: 'tool_call_output_item',
                output: JSON.stringify({
                    output: [
                        {
                            success: true,
                            operation: 'update_file',
                            path: 'existing.txt',
                            message: 'Updated existing.txt',
                        },
                    ],
                }),
                rawItem: {
                    type: 'function_call_result',
                    name: 'apply_patch',
                    arguments: {
                        type: 'update_file',
                        path: 'existing.txt',
                    },
                },
            },
        ];
        const messages = extractCommandMessages(items);

        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: '1700000000400-0-0',
            sender: 'command',
            command: 'apply_patch update_file existing.txt',
            output: 'Updated existing.txt',
            success: true,
        });
    } finally {
        restore();
    }
});

// test('extracts successful apply_patch delete_file operation', t => {
//     const restore = withStubbedNow(1700000000500);

//     try {
//         const items = [
//             {
//                 type: 'tool_call_output_item',
//                 output: JSON.stringify({
//                     output: [
//                         {
//                             success: true,
//                             operation: 'delete_file',
//                             path: 'to-delete.txt',
//                             message: 'Deleted to-delete.txt',
//                         },
//                     ],
//                 }),
//                 rawItem: {
//                     type: 'function_call_result',
//                     name: 'apply_patch',
//                     arguments: {
//                         type: 'delete_file',
//                         path: 'to-delete.txt',
//                     },
//                 },
//             },
//         ];
//         const messages = extractCommandMessages(items);

//         t.is(messages.length, 1);
//         t.deepEqual(messages[0], {
//             id: '1700000000500-0-0',
//             sender: 'command',
//             command: 'apply_patch delete_file to-delete.txt',
//             output: 'Deleted to-delete.txt',
//             success: true,
//         });
//     } finally {
//         restore();
//     }
// });

test('extracts failed apply_patch operation', t => {
    const restore = withStubbedNow(1700000000600);

    try {
        const items = [
            {
                type: 'tool_call_output_item',
                output: JSON.stringify({
                    output: [
                        {
                            success: false,
                            error: 'Invalid diff format',
                        },
                    ],
                }),
                rawItem: {
                    type: 'function_call_result',
                    name: 'apply_patch',
                    arguments: {
                        type: 'update_file',
                        path: 'bad.txt',
                    },
                },
            },
        ];
        const messages = extractCommandMessages(items);

        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: '1700000000600-0-0',
            sender: 'command',
            command: 'apply_patch update_file bad.txt',
            output: 'Invalid diff format',
            success: false,
        });
    } finally {
        restore();
    }
});
