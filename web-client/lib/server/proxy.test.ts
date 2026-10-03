import assert from 'node:assert/strict';
import test from 'node:test';
import { errorResponse, parsePage, validateEventCursor, validatePageCursor } from './proxy.js';
import { Term2GatewayError } from './term2-gateway-client.js';

test('settings conflicts preserve revision and projection details', async () => {
  const currentRevision = 'r2';
  const projection = { schemaVersion: 1, revision: currentRevision };
  const error = new Term2GatewayError('settings_conflict', undefined, { statusCode: 409 });
  error.details = { currentRevision, projection };

  const response = errorResponse(error);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(body.error.details, { currentRevision, projection });
});

test('does not expose gateway details for non-conflict errors', async () => {
  const error = new Term2GatewayError('gateway_unavailable', undefined, { statusCode: 503 });
  error.details = { internal: 'must not be forwarded' };

  const response = errorResponse(error);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(Object.hasOwn(body.error, 'details'), false);
});

test('accepts opaque base64url pagination cursors', () => {
  const cursor = 'eyJvZmZzZXQiOjIwfQ';
  assert.equal(validatePageCursor(cursor), cursor);
  assert.deepEqual(parsePage(new Request(`http://localhost/sessions?limit=20&cursor=${cursor}`)), {
    limit: 20,
    cursor,
  });
});

test('keeps event cursors numeric and rejects unsafe pagination cursor characters', () => {
  assert.equal(validateEventCursor('123'), '123');
  assert.throws(() => validateEventCursor('eyJvZmZzZXQiOjIwfQ'));
  assert.throws(() => validatePageCursor('abc+/='));
});
