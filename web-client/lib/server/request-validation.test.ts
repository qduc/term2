import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateAbortBody,
  validateCommandBody,
  validateInteractionBody,
} from './request-validation.js';

const id = 'abc123';

test('interaction text permits JSON whitespace but rejects other controls and caps all text fields', () => {
  assert.doesNotThrow(() =>
    validateInteractionBody({ revision: 1, answer: 'line 1\nline 2\r\t' }, id),
  );
  assert.throws(() => validateInteractionBody({ revision: 1, answer: 'bad\u0000' }, id));
  assert.throws(() => validateInteractionBody({ revision: 1, answer: 'x'.repeat(16_385) }, id));
  assert.throws(() => validateInteractionBody({ revision: 1, answer: 'ok', rejectionReason: 'x'.repeat(16_385) }, id));
});

test('abort and command bodies require exactly the gateway fields and opaque IDs', () => {
  assert.deepEqual(validateAbortBody({ turnId: id }), { turnId: id });
  assert.deepEqual(validateCommandBody({ commandId: 'compact', clientRequestId: id }), {
    commandId: 'compact',
    clientRequestId: id,
  });
  assert.throws(() => validateAbortBody({ turnId: id, extra: true }));
  assert.throws(() => validateAbortBody({ turnId: 'not valid' }));
  assert.throws(() => validateCommandBody({ commandId: 'compact', clientRequestId: 'not valid' }));
  assert.throws(() => validateCommandBody({ commandId: 'compact' }));
});
