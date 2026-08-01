import { expect, it } from 'vitest';
import { compareRecordedRequest } from './fixture-comparator.js';

const expected = {
  seq: 0,
  kind: 'http-request' as const,
  method: 'POST',
  urlPath: '/v1',
  headers: { 'content-type': 'application/json' },
  body: { model: 'fixture', response_id: '<1>', stream_options: { include_usage: true } },
};
it('compares requests semantically and ignores transport/SDK churn fields', () => {
  expect(
    compareRecordedRequest(
      expected,
      {
        ...expected,
        headers: { ...expected.headers, host: '127.0.0.1', connection: 'keep-alive' },
        body: { model: 'fixture', response_id: 'resp_live', stream_options: { include_usage: false } },
      },
      { placeholders: { resp_live: '<1>' } },
    ).equal,
  ).toBe(true);
});
it('reports a canonicalized request mutation', () => {
  const result = compareRecordedRequest(expected, { ...expected, body: { ...expected.body, model: 'wrong' } });
  expect(result.equal).toBe(false);
  expect(result.diff).toContain('wrong');
});
it('treats a redacted expected header value as matching any actual value', () => {
  expect(
    compareRecordedRequest(
      { ...expected, headers: { 'x-goog-api-key': '[REDACTED]' } },
      { ...expected, headers: { 'x-goog-api-key': 'AIzaSy-real-key-1234567890abcdef' } },
    ).equal,
  ).toBe(true);
  // ...but a header the expected frame declares and the app omits still fails.
  expect(
    compareRecordedRequest({ ...expected, headers: { 'x-goog-api-key': '[REDACTED]' } }, expected).equal,
  ).toBe(false);
});
