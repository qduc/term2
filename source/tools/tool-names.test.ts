import test from 'ava';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from './tool-names.js';

test('tool name constants remain stable', (t) => {
  t.is(TOOL_NAME_APPLY_PATCH, 'apply_patch');
  t.is(TOOL_NAME_SEARCH_REPLACE, 'search_replace');
});
