import { describe, it, expect, vi } from 'vitest';
import type { HostErrorCode, HostResult } from '../../../services/sandboxed-code-host/host-types.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { RunCodeActionReceipt, RunCodeCallRecord } from './run-code.js';
import { createRunCodeExecution, type RunCodeExecution } from './run-code-execution.js';
import {
  RUN_CODE_COMPLETION_EVENT,
  RUN_CODE_COMPLETION_MESSAGE,
  buildRunCodeCompletionMeta,
  emitRunCodeCompletionTelemetry,
} from './run-code-telemetry.js';

const failed = (code: HostErrorCode, message: string): HostResult => ({ ok: false, error: { code, message } });
const succeeded: HostResult = { ok: true, output: { done: true } };

const input = (overrides: Record<string, unknown> = {}) => {
  const calls = (overrides.calls as RunCodeCallRecord[] | undefined) ?? [];
  const receipts = (overrides.receipts as RunCodeActionReceipt[] | undefined) ?? [];
  const result = (overrides.result as HostResult | undefined) ?? succeeded;
  const execution =
    (overrides.execution as RunCodeExecution | undefined) ?? createRunCodeExecution(result, calls, receipts, []);
  return {
    code: 'return 1;',
    durationMs: 12,
    timeoutMs: 60_000,
    calls,
    receipts,
    sessionId: 'session-1',
    runId: 'run_code_bridge_1',
    ...overrides,
    execution,
  };
};

const executionForCase = (result: HostResult, failureClass?: string): RunCodeExecution => {
  const diagnostic =
    failureClass === 'unknown-tool'
      ? 'unknown_tool'
      : failureClass === 'parameter-shape'
      ? 'invalid_nested_input'
      : failureClass === 'budget'
      ? 'call_budget'
      : failureClass === 'approval-denied'
      ? 'approval_denied'
      : failureClass === 'nested-call'
      ? 'nested_tool_failure'
      : undefined;
  if (!diagnostic) return createRunCodeExecution(result, [], [], []);
  return {
    script: {
      status: 'failed',
      diagnostic: { code: diagnostic, message: result.ok ? 'failed' : result.error.message },
    },
    calls: [],
    actions: [],
    console: [],
    attachments: [],
    hostErrorCode: result.ok ? undefined : result.error.code,
  };
};

const call = (outcome: RunCodeCallRecord['outcome']): RunCodeCallRecord => ({
  tool: 'inspect',
  outcome,
  durationMs: 1,
});

const collectStrings = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, found));
  return found;
};

describe('run_code completion telemetry', () => {
  it('counts nested calls and effect receipts across the ledgers', () => {
    const meta = buildRunCodeCompletionMeta(
      input({
        calls: [
          call('ok'),
          call('ok'),
          call('describe'),
          call('unknown_tool'),
          call('invalid_params'),
          call('approval_required'),
          call('error'),
        ],
        receipts: [
          { callId: 'a', tool: 'cancel_run', outcome: 'applied' },
          { callId: 'b', tool: 'cancel_run', outcome: 'not_applied' },
          { callId: 'c', tool: 'cancel_run', outcome: 'failed' },
          { callId: 'd', tool: 'cancel_run', outcome: 'unknown' },
        ],
      }),
    );

    expect(meta.outcome).toBe('success');
    expect(meta.nested).toEqual({
      calls: 6,
      schemaLookups: 1,
      ok: 2,
      unknownTool: 1,
      invalidParams: 1,
      approvalDenied: 1,
      prohibited: 0,
      otherFailures: 1,
    });
    expect(meta.effectReceipts).toEqual({ applied: 1, notApplied: 1, failed: 1, unknown: 1 });
  });

  it('accounts for every ledger outcome exactly once', () => {
    const outcomes: RunCodeCallRecord['outcome'][] = [
      'ok',
      'error',
      'approval_required',
      'unknown_policy',
      'policy_error',
      'interceptor_denied',
      'unknown_tool',
      'invalid_params',
      'prohibited',
      'describe',
    ];

    for (const outcome of outcomes) {
      const nested = buildRunCodeCompletionMeta(input({ calls: [call(outcome)] })).nested as Record<string, number>;
      expect(nested.calls + nested.schemaLookups).toBe(1);
    }
  });

  const cases: Array<{ name: string; result: HostResult; outcome: string; failureClass?: string; code: string }> = [
    { name: 'success', result: succeeded, outcome: 'success', code: 'none' },
    {
      name: 'syntax error',
      result: failed('syntax_error', 'Unexpected identifier'),
      outcome: 'parse',
      code: 'syntax_error',
    },
    {
      name: 'script runtime error',
      result: failed('runtime_error', 'ReferenceError: nope is not defined'),
      outcome: 'runtime',
      code: 'runtime_error',
    },
    {
      name: 'nested parameter shape',
      result: failed('runtime_error', 'tools.read_file failed: Invalid parameters for "read_file": path: Required'),
      outcome: 'nested-validation',
      failureClass: 'parameter-shape',
      code: 'runtime_error',
    },
    {
      name: 'nested unknown tool through describe',
      result: failed('runtime_error', 'tools.describe failed: Unknown tool "missing". Available: read_file'),
      outcome: 'nested-validation',
      failureClass: 'unknown-tool',
      code: 'runtime_error',
    },
    {
      name: 'unknown namespace member',
      result: failed('runtime_error', 'Unknown tool "read_files". Available: read_file'),
      outcome: 'nested-validation',
      failureClass: 'unknown-tool',
      code: 'runtime_error',
    },
    {
      name: 'other nested rejection',
      result: failed('runtime_error', 'tools.apply_patch failed: denied by policy'),
      outcome: 'nested-validation',
      failureClass: 'nested-call',
      code: 'runtime_error',
    },
    {
      name: 'non-JSON return',
      result: failed('invalid_output', 'Script return value is not JSON-safe'),
      outcome: 'return-serialization',
      code: 'invalid_output',
    },
    {
      name: 'timeout',
      result: failed('timeout', 'Script exceeded its configured timeout'),
      outcome: 'timeout',
      code: 'timeout',
    },
    {
      name: 'deadline',
      result: failed('deadline', 'Script exceeded its deadline'),
      outcome: 'timeout',
      code: 'deadline',
    },
    { name: 'cancelled', result: failed('cancelled', 'Script was cancelled'), outcome: 'cancelled', code: 'cancelled' },
    {
      name: 'oversized source',
      result: failed('code_too_large', 'too large'),
      outcome: 'input-rejected',
      code: 'code_too_large',
    },
    {
      name: 'unavailable sandbox',
      result: failed('sandbox_unavailable', 'sandbox is unavailable'),
      outcome: 'host-unavailable',
      code: 'sandbox_unavailable',
    },
    {
      name: 'nested call budget',
      result: failed('limit_exceeded', 'Tool call limit reached'),
      outcome: 'nested-validation',
      failureClass: 'budget',
      code: 'limit_exceeded',
    },
    {
      name: 'approval refusal',
      result: failed('approval_required', 'Tool execution was not approved'),
      outcome: 'nested-validation',
      failureClass: 'approval-denied',
      code: 'approval_required',
    },
  ];

  it.each(cases)('classifies $name', ({ result, outcome, failureClass, code }) => {
    const meta = buildRunCodeCompletionMeta(input({ execution: executionForCase(result, failureClass) }));

    expect(meta.outcome).toBe(outcome);
    expect(meta.failureClass).toBe(failureClass);
    expect(meta.hostErrorCode).toBe(code === 'none' ? undefined : code);
  });

  it('does not attribute a message that only resembles a nested rejection', () => {
    const resembles = 'before tools.search failed: rg: boom';
    const emptyMember = 'tools. failed: boom';
    const emptyDetail = 'tools.search failed: ';

    expect(
      buildRunCodeCompletionMeta(input({ execution: executionForCase(failed('runtime_error', resembles)) })).outcome,
    ).toBe('runtime');
    expect(
      buildRunCodeCompletionMeta(input({ execution: executionForCase(failed('runtime_error', emptyMember)) })).outcome,
    ).toBe('runtime');
    expect(
      buildRunCodeCompletionMeta(
        input({
          execution: {
            script: { status: 'failed', diagnostic: { code: 'nested_tool_failure', message: emptyDetail } },
            calls: [],
            actions: [],
            console: [],
            attachments: [],
            hostErrorCode: 'runtime_error',
          },
        }),
      ).failureClass,
    ).toBe('nested-call');
  });

  it('emits numbers, closed-set enums, and a digest but never the source or its text', () => {
    const code = 'return await tools.read_file({ path: "/srv/private/secret-notes.md" });';
    const meta = buildRunCodeCompletionMeta(
      input({
        code,
        execution: executionForCase(
          failed(
            'runtime_error',
            'tools.read_file failed: Invalid parameters for "read_file": path: /srv/private/secret-notes.md is not readable',
          ),
          'parameter-shape',
        ),
      }),
    );

    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('/srv/private');
    expect(serialized).not.toContain('secret-notes.md');
    expect(serialized).not.toContain('read_file');
    expect(serialized).not.toContain('Invalid parameters');
    expect(meta.sourceDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.sourceBytes).toBe(Buffer.byteLength(code, 'utf8'));
    expect(meta.sourceLines).toBe(1);

    for (const value of collectStrings(meta)) {
      const allowed =
        value === RUN_CODE_COMPLETION_EVENT ||
        value === 'run_code' ||
        value === 'session-1' ||
        value === 'run_code_bridge_1' ||
        /^[a-z]+([_-][a-z]+)*$/.test(value) ||
        /^[0-9a-f]{16}$/.test(value);
      expect(allowed).toBe(true);
    }
  });

  it('keys a source digest by content so repetition is visible across invocations', () => {
    const first = buildRunCodeCompletionMeta(input({ code: 'return 1;' }));
    const same = buildRunCodeCompletionMeta(input({ code: 'return 1;', durationMs: 99 }));
    const other = buildRunCodeCompletionMeta(input({ code: 'return 2;' }));

    expect(first.sourceDigest).toBe(same.sourceDigest);
    expect(other.sourceDigest).not.toBe(first.sourceDigest);
  });

  it('counts source lines without counting an empty script as one line', () => {
    expect(buildRunCodeCompletionMeta(input({ code: '' })).sourceLines).toBe(0);
  });

  it('emits one info event and never fails the caller when logging does', () => {
    const logger = { info: vi.fn() } as unknown as ILoggingService;
    emitRunCodeCompletionTelemetry(logger, input());

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      RUN_CODE_COMPLETION_MESSAGE,
      expect.objectContaining({ eventType: RUN_CODE_COMPLETION_EVENT, outcome: 'success' }),
    );

    const throwing = {
      info: () => {
        throw new Error('disk full');
      },
    } as unknown as ILoggingService;
    expect(() => emitRunCodeCompletionTelemetry(throwing, input())).not.toThrow();
  });

  it('classifies the same diagnostic code identically when its wording changes', () => {
    const execution = (message: string): RunCodeExecution => ({
      script: { status: 'failed', diagnostic: { code: 'unknown_tool', message } },
      calls: [],
      actions: [],
      console: [],
      attachments: [],
    });
    const first = buildRunCodeCompletionMeta(input({ execution: execution('first wording') }));
    const second = buildRunCodeCompletionMeta(input({ execution: execution('a different private detail') }));

    expect(second.outcome).toBe(first.outcome);
    expect(second.diagnosticCode).toBe(first.diagnosticCode);
    expect(second.failureClass).toBe(first.failureClass);
    expect(JSON.stringify(second)).not.toContain('private detail');
  });

  it.each([
    'syntax',
    'runtime',
    'unknown_tool',
    'invalid_nested_input',
    'invalid_nested_output',
    'nested_tool_failure',
    'unhandled_nested_failure',
    'call_budget',
    'invalid_script_return',
    'timeout',
    'deadline',
    'cancellation',
    'oversized_code',
    'sandbox_unavailable',
  ] as const)('keeps %s as a stable diagnostic discriminant', (code) => {
    const execution = createRunCodeExecution(
      { ok: false, error: { code: code === 'syntax' ? 'syntax_error' : 'runtime_error', message: 'wording' } },
      [{ tool: 'x', outcome: 'error', durationMs: 1, diagnostic: code }],
      [],
      [],
    );
    expect(execution.script.status).toBe('failed');
    if (execution.script.status === 'failed') expect(execution.script.diagnostic.code).toBe(code);
  });
});
