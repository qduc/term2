import { it, expect } from 'vitest';
import {
  TOOL_NAME_APPLY_PATCH,
  TOOL_NAME_CODE_CONTEXT_SEARCH,
  TOOL_NAME_CREATE_FILE,
  TOOL_NAME_READ_CODE_OUTLINE,
  TOOL_NAME_SEARCH_REPLACE,
  TOOL_NAME_MEMORY_LIST,
} from './tool-names.js';

it('tool name constants remain stable', () => {
  expect(TOOL_NAME_APPLY_PATCH).toBe('apply_patch');
  expect(TOOL_NAME_CREATE_FILE).toBe('create_file');
  expect(TOOL_NAME_SEARCH_REPLACE).toBe('search_replace');
  expect(TOOL_NAME_READ_CODE_OUTLINE).toBe('read_code_outline');
  expect(TOOL_NAME_CODE_CONTEXT_SEARCH).toBe('code_context_search');
  expect(TOOL_NAME_MEMORY_LIST).toBe('memory_list');
});
