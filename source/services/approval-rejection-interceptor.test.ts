import test from 'ava';
import {
  installApprovalRejectionInterceptor,
  tryInstallApprovalRejectionInterceptor,
} from './approval-rejection-interceptor.js';
import { clearApprovalRejectionMarkers, extractCommandMessages } from '../utils/extract-command-messages.js';

test.beforeEach(() => {
  clearApprovalRejectionMarkers();
});

test.afterEach(() => {
  clearApprovalRejectionMarkers();
});

test('installApprovalRejectionInterceptor intercepts matching tool call and marks approval rejection', async (t) => {
  let capturedInterceptor;
  let removed = false;

  const remove = installApprovalRejectionInterceptor(
    {
      addToolInterceptor(interceptor) {
        capturedInterceptor = interceptor;
        return () => {
          removed = true;
        };
      },
    },
    {
      toolName: 'shell',
      expectedCallId: 'call-1',
      rejectionMessage: 'Tool execution was not approved.',
    },
  );

  t.truthy(capturedInterceptor);
  t.is(await capturedInterceptor('grep', {}, 'call-1'), null);
  t.is(await capturedInterceptor('shell', {}, 'call-2'), null);
  t.is(await capturedInterceptor('shell', {}, 'call-1'), 'Tool execution was not approved.');

  const messages = extractCommandMessages([
    {
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'ls source' }),
      },
    },
    {
      rawItem: {
        type: 'function_call_output',
        callId: 'call-1',
        name: 'shell',
        output: 'exit 0\nsource',
      },
    },
  ]);

  t.true(messages.length >= 1);
  t.true(messages[0].isApprovalRejection === true);

  remove();
  t.true(removed);
});

test('tryInstallApprovalRejectionInterceptor returns null when interceptor support is unavailable', (t) => {
  const remove = tryInstallApprovalRejectionInterceptor(
    {},
    {
      toolName: 'shell',
      expectedCallId: 'call-1',
      rejectionMessage: 'Tool execution was not approved.',
    },
  );

  t.is(remove, null);
});
