import test from 'ava';
import Fuse from 'fuse.js';
import {
  buildSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  type SettingValueSuggestion,
} from './use-settings-value-completion.js';

test('buildSettingValueSuggestions returns enum suggestions for reasoningEffort', (t) => {
  const result = buildSettingValueSuggestions('agent.reasoningEffort');
  const values = result.map((r) => r.value);
  t.true(values.includes('low'));
  t.true(values.includes('medium'));
  t.true(values.includes('high'));
  t.true(values.includes('default'));
});

test('buildSettingValueSuggestions returns boolean suggestions for boolean settings', (t) => {
  const result = buildSettingValueSuggestions('logging.suppressConsoleOutput');
  t.deepEqual(result.map((r) => r.value).sort(), ['false', 'true']);
});

test('filterSettingValueSuggestionsByQuery filters by partial match', (t) => {
  const suggestions: SettingValueSuggestion[] = [
    { value: 'debug' },
    { value: 'info' },
    { value: 'warn' },
    { value: 'error' },
  ];

  const fuse = new Fuse(suggestions, {
    keys: ['value', 'description'],
    threshold: 0.4,
  });

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'err', fuse, 10);

  t.true(result.some((r) => r.value === 'error'));
});

test('filterSettingValueSuggestionsByQuery includes custom number value for number settings', (t) => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const fuse = new Fuse(suggestions, {
    keys: ['value', 'description'],
    threshold: 0.4,
  });

  const result = filterSettingValueSuggestionsByQuery(suggestions, '150', fuse, 10, 'ui.historySize');

  t.true(result.length >= 1);
  t.is(result[0]?.value, '150');
  t.is(result[0]?.description, 'Custom value');
});

test('filterSettingValueSuggestionsByQuery does not include custom number if already present', (t) => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const fuse = new Fuse(suggestions, {
    keys: ['value', 'description'],
    threshold: 0.4,
  });

  const result = filterSettingValueSuggestionsByQuery(suggestions, '100', fuse, 10, 'ui.historySize');

  t.true(result.length >= 1);
  t.is(result[0]?.value, '100');
  t.not(result[0]?.description, 'Custom value');
  t.false(result.some((r) => r.description === 'Custom value'));
});

test('filterSettingValueSuggestionsByQuery does not include non-number custom values even for number settings', (t) => {
  const suggestions: SettingValueSuggestion[] = [];
  const fuse = new Fuse(suggestions, {});

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'abc', fuse, 10, 'ui.historySize');

  t.is(result.length, 0);
});
