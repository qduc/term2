import { describe, it, expect } from 'vitest';
import {
  isScriptedToolCall,
  resolveResultMaxBytesForCall,
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  SCRIPTED_TOOL_RESULT_MAX_BYTES,
} from './bound-tool-result.js';

describe('scripted tool-call boundary', () => {
  it('recognises only an explicit scripted marker', () => {
    expect(isScriptedToolCall({ scripted: true })).toBe(true);
    expect(isScriptedToolCall({ scripted: 'yes' })).toBe(false);
    expect(isScriptedToolCall({})).toBe(false);
    expect(isScriptedToolCall(undefined)).toBe(false);
    expect(isScriptedToolCall(null)).toBe(false);
  });

  it('gives a scripted call the larger cap and a direct call the context cap', () => {
    expect(resolveResultMaxBytesForCall({ scripted: true })).toBe(SCRIPTED_TOOL_RESULT_MAX_BYTES);
    expect(resolveResultMaxBytesForCall({})).toBe(DEFAULT_TOOL_RESULT_MAX_BYTES);
  });

  it('lets an explicit override win over both', () => {
    // A caller that has chosen a cap knows something the boundary does not.
    expect(resolveResultMaxBytesForCall({ scripted: true }, 500)).toBe(500);
    expect(resolveResultMaxBytesForCall({}, 500)).toBe(500);
  });
});
