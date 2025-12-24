import test from 'ava';
import {
    clearApprovalRejectionMarkers,
    extractCommandMessages,
} from '../../dist/utils/extract-command-messages.js';

const withStubbedNow = value => {
    const realNow = Date.now;
    Date.now = () => value;
    return () => {
        Date.now = realNow;
    };
};

test.beforeEach(() => {
    clearApprovalRejectionMarkers();
});

test('extracts failure reason from shell command outcome', t => {
    const restore = withStubbedNow(1700000000200);

    try {
        const items = [
            {
                type: 'tool_call_output_item',
                output: 'timeout\n',
                rawItem: {
                    type: 'function_call_result',
                    name: 'shell',
                    arguments: JSON.stringify({
                        command: 'rg -n "DEFAULT_TRIM_CONFIG"',
                    }),
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
            isApprovalRejection: false,
        });
    } finally {
        restore();
    }
});

test('extracts shell command from matching function_call item', t => {
    const restore = withStubbedNow(1700000000250);

    try {
        const items = [
            {
                type: 'function_call',
                id: 'call-abc',
                name: 'shell',
                arguments: JSON.stringify({command: 'echo hi'}),
            },
            {
                type: 'tool_call_output_item',
                output: 'exit 0\nhi',
                rawItem: {
                    type: 'function_call_result',
                    name: 'shell',
                    callId: 'call-abc',
                },
            },
        ];

        const messages = extractCommandMessages(items);
        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: 'call-abc-0',
            callId: 'call-abc',
            sender: 'command',
            command: 'echo hi',
            output: 'hi',
            success: true,
            failureReason: undefined,
            isApprovalRejection: false,
        });
    } finally {
        restore();
    }
});

test('extracts shell command from output items using call_id', t => {
    const restore = withStubbedNow(1700000000261);

    try {
        const items = [
            {
                type: 'function_call',
                id: 'call-abc',
                name: 'shell',
                arguments: JSON.stringify({command: 'npm run lint'}),
            },
            {
                type: 'tool_call_output_item',
                output: 'exit 0\n> md-preview@0.0.0 lint\n> eslint .',
                rawItem: {
                    type: 'function_call_result',
                    name: 'shell',
                    id: 'result-1',
                    call_id: 'call-abc',
                },
            },
        ];

        const messages = extractCommandMessages(items);
        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: 'result-1-0',
            callId: 'call-abc',
            sender: 'command',
            command: 'npm run lint',
            output: '> md-preview@0.0.0 lint\n> eslint .',
            success: true,
            failureReason: undefined,
            isApprovalRejection: false,
        });
    } finally {
        restore();
    }
});

test('extracts grep output from plain text tool result', t => {
    const restore = withStubbedNow(1700000000260);

    try {
        const items = [
            {
                type: 'tool_call_output_item',
                output: 'source/app.tsx:1:hello',
                rawItem: {
                    type: 'function_call_result',
                    name: 'grep',
                    id: 'call-grep-1',
                    arguments: JSON.stringify({
                        pattern: 'hello',
                        path: 'source',
                        case_sensitive: false,
                        file_pattern: null,
                        exclude_pattern: null,
                        max_results: 100,
                    }),
                },
            },
        ];

        const messages = extractCommandMessages(items);
        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: 'call-grep-1',
            callId: 'call-grep-1',
            sender: 'command',
            command: 'grep "hello" "source"',
            output: 'source/app.tsx:1:hello',
            success: true,
            isApprovalRejection: false,
        });
    } finally {
        restore();
    }
});

test('extracts grep command from matching function_call item', t => {
    const restore = withStubbedNow(1700000000265);

    try {
        const items = [
            {
                type: 'function_call',
                id: 'call-grep-abc',
                name: 'grep',
                arguments: JSON.stringify({
                    pattern: 'DEFAULT_TRIM_CONFIG',
                    path: 'source',
                    case_sensitive: true,
                    file_pattern: '*.ts',
                    exclude_pattern: null,
                    max_results: 100,
                }),
            },
            {
                type: 'tool_call_output_item',
                output: 'source/utils/output-trim.ts:12:export const DEFAULT_TRIM_CONFIG',
                rawItem: {
                    type: 'function_call_result',
                    name: 'grep',
                    callId: 'call-grep-abc',
                },
            },
        ];

        const messages = extractCommandMessages(items);
        t.is(messages.length, 1);
        t.deepEqual(messages[0], {
            id: 'call-grep-abc',
            callId: 'call-grep-abc',
            sender: 'command',
            command: 'grep "DEFAULT_TRIM_CONFIG" "source" --case-sensitive --include "*.ts"',
            output: 'source/utils/output-trim.ts:12:export const DEFAULT_TRIM_CONFIG',
            success: true,
            isApprovalRejection: false,
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
            isApprovalRejection: false,
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
            isApprovalRejection: false,
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
            isApprovalRejection: false,
        });
    } finally {
        restore();
    }
});
