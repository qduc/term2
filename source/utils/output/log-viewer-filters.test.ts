import test from 'ava';
import { applyViewerFilters, withPreset } from './log-viewer-filters.js';

const rows = [
  {
    raw: '{"eventType":"retry.hallucination","traceId":"t1"}',
    parsed: {
      level: 'warn',
      eventType: 'retry.hallucination',
      traceId: 't1',
      sessionId: 's1',
      toolName: 'shell',
      provider: 'openai',
      model: 'gpt-5',
    },
  },
  {
    raw: '{"eventType":"tool_call.parse_failed","traceId":"t2"}',
    parsed: {
      level: 'error',
      eventType: 'tool_call.parse_failed',
      traceId: 't2',
      sessionId: 's2',
      toolName: 'search_replace',
      provider: 'openrouter',
      model: 'claude',
    },
  },
] as const;

test('applyViewerFilters filters by structured fields', (t) => {
  const filtered = applyViewerFilters(rows as any, {
    traceId: 't2',
    eventType: 'tool_call.parse_failed',
    toolName: 'search_replace',
  });
  t.is(filtered.length, 1);
  t.is(filtered[0].parsed?.traceId, 't2');
});

test('applyViewerFilters supports prefix eventType matching', (t) => {
  const filtered = applyViewerFilters(rows as any, { eventType: 'retry.' });
  t.is(filtered.length, 1);
  t.is(filtered[0].parsed?.eventType, 'retry.hallucination');
});

test('withPreset applies invalid tool format preset', (t) => {
  const filters = withPreset({ traceId: 't2' }, 'invalid_tool_format');
  t.is(filters.traceId, 't2');
  t.is(filters.eventType, 'tool_call.parse_failed');
});
