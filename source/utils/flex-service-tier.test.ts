import test from 'ava';
import { APICallError } from '@ai-sdk/provider';
import { isFlexServiceTierTimeout } from './flex-service-tier.js';

test('isFlexServiceTierTimeout detects OpenRouter 200 stream timeout payloads', (t) => {
  const error = new APICallError({
    message: 'OpenRouter stream failed',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 200,
    responseBody:
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"error":{"code":504,"message":"The operation was aborted","metadata":{"error_type":"timeout"}}}\n\n',
  });

  t.true(isFlexServiceTierTimeout(error));
});

test('isFlexServiceTierTimeout ignores unrelated retryable errors', (t) => {
  const error = new APICallError({
    message: 'Rate limited',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
    responseBody: '{"error":{"code":429,"message":"Too many requests"}}',
  });

  t.false(isFlexServiceTierTimeout(error));
});
