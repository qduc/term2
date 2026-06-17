import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { clearApprovalRejectionMarkers, extractCommandMessages } from './extract-command-messages.js';
import { clearToolFormatters, registerToolFormatters } from '../../tools/command-message-formatters.js';
import { formatApplyPatchCommandMessage } from '../../tools/file/apply-patch.js';
import { formatAskMentorCommandMessage } from '../../tools/agent/ask-mentor.js';
import {
  formatCodeContextSearchCommandMessage,
  formatReadCodeOutlineCommandMessage,
} from '../../tools/system/code-context.js';
import { formatGrepCommandMessage } from '../../tools/system/grep.js';
import { formatReadFileCommandMessage } from '../../tools/file/read-file.js';
import { formatShellCommandMessage } from '../../tools/system/shell.js';

const withStubbedNow = (value: number) => {
  const realNow = Date.now;
  Date.now = () => value;
  return () => {
    Date.now = realNow;
  };
};

beforeEach(() => {
  clearApprovalRejectionMarkers();
  clearToolFormatters();
  registerToolFormatters([
    { name: 'apply_patch', formatCommandMessage: formatApplyPatchCommandMessage },
    { name: 'ask_mentor', formatCommandMessage: formatAskMentorCommandMessage },
    { name: 'code_context_search', formatCommandMessage: formatCodeContextSearchCommandMessage },
    { name: 'grep', formatCommandMessage: formatGrepCommandMessage },
    { name: 'read_code_outline', formatCommandMessage: formatReadCodeOutlineCommandMessage },
    { name: 'read_file', formatCommandMessage: formatReadFileCommandMessage },
    { name: 'shell', formatCommandMessage: formatShellCommandMessage },
  ]);
});

afterEach(() => {
  clearApprovalRejectionMarkers();
  clearToolFormatters();
});

it('extracts failure reason from shell command outcome', () => {
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

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000200-0-0',
      sender: 'command',
      status: 'completed',
      command: 'rg -n "DEFAULT_TRIM_CONFIG"',
      output: 'No output',
      success: false,
      failureReason: 'timeout',
      isApprovalRejection: false,
      toolName: 'shell',
    });
  } finally {
    restore();
  }
});

it('extracts shell command from matching function_call item', () => {
  const restore = withStubbedNow(1700000000250);

  try {
    const items = [
      {
        type: 'function_call',
        id: 'call-abc',
        name: 'shell',
        arguments: JSON.stringify({ command: 'echo hi' }),
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
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: 'call-abc-0',
      callId: 'call-abc',
      sender: 'command',
      status: 'completed',
      command: 'echo hi',
      output: 'hi',
      success: true,
      failureReason: undefined,
      isApprovalRejection: false,
      toolName: 'shell',
    });
  } finally {
    restore();
  }
});

it('extracts shell command from output items using call_id', () => {
  const restore = withStubbedNow(1700000000261);

  try {
    const items = [
      {
        type: 'function_call',
        id: 'call-abc',
        name: 'shell',
        arguments: JSON.stringify({ command: 'npm run lint' }),
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
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: 'result-1-0',
      callId: 'call-abc',
      sender: 'command',
      status: 'completed',
      command: 'npm run lint',
      output: '> md-preview@0.0.0 lint\n> eslint .',
      success: true,
      failureReason: undefined,
      isApprovalRejection: false,
      toolName: 'shell',
    });
  } finally {
    restore();
  }
});

it('extracts grep output from plain text tool result', () => {
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
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: 'call-grep-1-0',
      callId: 'call-grep-1',
      sender: 'command',
      status: 'completed',
      command: 'grep "hello" "source" --ignore-case',
      output: 'source/app.tsx:1:hello',
      success: true,
      isApprovalRejection: false,
      toolName: 'grep',
      toolArgs: {
        pattern: 'hello',
        path: 'source',
        case_sensitive: false,
        file_pattern: null,
        exclude_pattern: null,
        max_results: 100,
      },
    });
  } finally {
    restore();
  }
});

it('extracts grep command from matching function_call item', () => {
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
    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: 'call-grep-abc-0',
      callId: 'call-grep-abc',
      sender: 'command',
      status: 'completed',
      command: 'grep "DEFAULT_TRIM_CONFIG" "source" --case-sensitive --include "*.ts"',
      output: 'source/utils/output-trim.ts:12:export const DEFAULT_TRIM_CONFIG',
      success: true,
      isApprovalRejection: false,
      toolName: 'grep',
      toolArgs: {
        pattern: 'DEFAULT_TRIM_CONFIG',
        path: 'source',
        case_sensitive: true,
        file_pattern: '*.ts',
        exclude_pattern: null,
        max_results: 100,
      },
    });
  } finally {
    restore();
  }
});

it('grep output containing "error" or "failed" should still be success', () => {
  const restore = withStubbedNow(1700000000270);

  try {
    // Test case where grep results contain the word "error" in the matched content
    const items = [
      {
        type: 'tool_call_output_item',
        output: 'source/utils/error-handler.ts:5:  if (error) {',
        rawItem: {
          type: 'function_call_result',
          name: 'grep',
          id: 'call-grep-error-1',
          arguments: JSON.stringify({
            pattern: 'error',
            path: 'source',
          }),
        },
      },
    ];

    const messages = extractCommandMessages(items);
    expect(messages.length).toBe(1);
    expect(messages[0].success, 'grep result with "error" in content should be success').toBe(true);

    // Test case where grep results contain the word "failed"
    const items2 = [
      {
        type: 'tool_call_output_item',
        output: 'source/test/test.ts:10:it("should handle failed state", () => {})',
        rawItem: {
          type: 'function_call_result',
          name: 'grep',
          id: 'call-grep-failed-1',
          arguments: JSON.stringify({
            pattern: 'failed',
            path: 'source',
          }),
        },
      },
    ];

    const messages2 = extractCommandMessages(items2);
    expect(messages2.length).toBe(1);
    expect(messages2[0].success, 'grep result with "failed" in content should be success').toBe(true);
  } finally {
    restore();
  }
});

it('grep with no matches is still a success', () => {
  const restore = withStubbedNow(1700000000275);

  try {
    const items = [
      {
        type: 'tool_call_output_item',
        output: 'No matches found.',
        rawItem: {
          type: 'function_call_result',
          name: 'grep',
          id: 'call-grep-nomatch-1',
          arguments: JSON.stringify({
            pattern: 'nonexistent_pattern_12345',
            path: 'source',
          }),
        },
      },
    ];

    const messages = extractCommandMessages(items);
    expect(messages.length).toBe(1);
    expect(messages[0].success, 'grep with no matches should be success, not error').toBe(true);
    expect(messages[0].output).toBe('No matches found.');
  } finally {
    restore();
  }
});

it('extracts successful apply_patch create_file operation', () => {
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

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000300-0-0',
      sender: 'command',
      status: 'completed',
      command: 'apply_patch create_file test.txt',
      output: 'Created test.txt',
      success: true,
      isApprovalRejection: false,
      toolName: 'apply_patch',
      toolArgs: {
        path: 'test.txt',
        diff: '',
        type: 'create_file',
      },
    });
  } finally {
    restore();
  }
});

it('extracts successful apply_patch update_file operation', () => {
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

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000400-0-0',
      sender: 'command',
      status: 'completed',
      command: 'apply_patch update_file existing.txt',
      output: 'Updated existing.txt',
      success: true,
      isApprovalRejection: false,
      toolName: 'apply_patch',
      toolArgs: {
        path: 'existing.txt',
        diff: '',
        type: 'update_file',
      },
    });
  } finally {
    restore();
  }
});

// it('extracts successful apply_patch delete_file operation', t => {
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

//         expect(messages.length).toBe(1);
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

it('extracts failed apply_patch operation', () => {
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

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000600-0-0',
      sender: 'command',
      status: 'completed',
      command: 'apply_patch update_file bad.txt',
      output: 'Invalid diff format',
      success: false,
      isApprovalRejection: false,
      toolName: 'apply_patch',
      toolArgs: {
        path: 'bad.txt',
        diff: '',
        type: 'update_file',
      },
    });
  } finally {
    restore();
  }
});

it('extracts native apply_patch_call output with diff args', () => {
  const restore = withStubbedNow(1700000000650);

  try {
    const items = [
      {
        type: 'apply_patch_call',
        callId: 'native-call-1',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'native.txt',
          diff: '@@ -1 +1 @@\n-old\n+new',
        },
      },
      {
        type: 'apply_patch_call_output',
        output: 'Updated native.txt',
        rawItem: {
          type: 'apply_patch_call_output',
          callId: 'native-call-1',
          status: 'completed',
          output: 'Updated native.txt',
        },
      },
    ];

    const messages = extractCommandMessages(items);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: 'native-call-1-0',
      callId: 'native-call-1',
      sender: 'command',
      status: 'completed',
      command: 'apply_patch update_file native.txt',
      output: 'Updated native.txt',
      success: true,
      isApprovalRejection: false,
      toolName: 'apply_patch',
      toolArgs: {
        path: 'native.txt',
        diff: '@@ -1 +1 @@\n-old\n+new',
        type: 'update_file',
      },
    });
  } finally {
    restore();
  }
});

it('extracts ask_mentor output', () => {
  const restore = withStubbedNow(1700000000700);

  try {
    const items = [
      {
        type: 'tool_call_output_item',
        output: 'The answer is 42.',
        rawItem: {
          type: 'function_call_result',
          name: 'ask_mentor',
          arguments: JSON.stringify({
            question: 'What is the meaning of life?',
          }),
        },
      },
    ];
    const messages = extractCommandMessages(items);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000700-0-0',
      sender: 'command',
      status: 'completed',
      command: 'ask_mentor: What is the meaning of life?',
      output: 'The answer is 42.',
      success: true,
      isApprovalRejection: false,
      toolName: 'ask_mentor',
      toolArgs: {
        question: 'What is the meaning of life?',
      },
    });
  } finally {
    restore();
  }
});

it('extracts read_file output', () => {
  const restore = withStubbedNow(1700000000800);

  try {
    const items = [
      {
        type: 'tool_call_output_item',
        output: '1\tline one\n2\tline two',
        rawItem: {
          type: 'function_call_result',
          name: 'read_file',
          arguments: JSON.stringify({
            path: 'test.txt',
            start_line: 1,
            end_line: 2,
          }),
        },
      },
    ];
    const messages = extractCommandMessages(items);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000800-0-0',
      sender: 'command',
      status: 'completed',
      command: 'read_file "test.txt" --lines 1-2',
      output: '1\tline one\n2\tline two',
      success: true,
      isApprovalRejection: false,
      toolName: 'read_file',
      toolArgs: {
        path: 'test.txt',
        start_line: 1,
        end_line: 2,
      },
    });
  } finally {
    restore();
  }
});

it('extracts read_code_outline output', () => {
  const restore = withStubbedNow(1700000000900);

  try {
    const items = [
      {
        type: 'tool_call_output_item',
        output: 'FILE source/app.tsx\nLANG typescript',
        rawItem: {
          type: 'function_call_result',
          name: 'read_code_outline',
          arguments: JSON.stringify({
            path: 'source/app.tsx',
          }),
        },
      },
    ];
    const messages = extractCommandMessages(items);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000900-0-0',
      sender: 'command',
      status: 'completed',
      command: 'read_code_outline "source/app.tsx"',
      output: 'FILE source/app.tsx\nLANG typescript',
      success: true,
      isApprovalRejection: false,
      toolName: 'read_code_outline',
      toolArgs: {
        path: 'source/app.tsx',
      },
    });
  } finally {
    restore();
  }
});

it('extracts code_context_search output', () => {
  const restore = withStubbedNow(1700000000910);

  try {
    const items = [
      {
        type: 'tool_call_output_item',
        output: 'QUERY symbol\nSYMBOL getAgentDefinition',
        rawItem: {
          type: 'function_call_result',
          name: 'code_context_search',
          arguments: JSON.stringify({
            query_type: 'symbol',
            symbol: 'getAgentDefinition',
          }),
        },
      },
    ];
    const messages = extractCommandMessages(items);

    expect(messages.length).toBe(1);
    expect(messages[0]).toEqual({
      id: '1700000000910-0-0',
      sender: 'command',
      status: 'completed',
      command: 'code_context_search symbol "getAgentDefinition"',
      output: 'QUERY symbol\nSYMBOL getAgentDefinition',
      success: true,
      isApprovalRejection: false,
      toolName: 'code_context_search',
      toolArgs: {
        query_type: 'symbol',
        symbol: 'getAgentDefinition',
      },
    });
  } finally {
    restore();
  }
});
