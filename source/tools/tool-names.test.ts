import test from 'ava';
import {
  TOOL_NAME_APPLY_PATCH,
  TOOL_NAME_CODE_CONTEXT_SEARCH,
  TOOL_NAME_CREATE_FILE,
  TOOL_NAME_READ_CODE_OUTLINE,
  TOOL_NAME_SEARCH_REPLACE,
} from './tool-names.js';

test('tool name constants remain stable', (t) => {
  t.is(TOOL_NAME_APPLY_PATCH, 'apply_patch');
  t.is(TOOL_NAME_CREATE_FILE, 'create_file');
  t.is(TOOL_NAME_SEARCH_REPLACE, 'search_replace');
  t.is(TOOL_NAME_READ_CODE_OUTLINE, 'read_code_outline');
  t.is(TOOL_NAME_CODE_CONTEXT_SEARCH, 'code_context_search');
});
