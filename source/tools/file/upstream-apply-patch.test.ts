import { describe, expect, it } from 'vitest';
import { extractPatchPaths, parseUpstreamApplyPatch, UPSTREAM_APPLY_PATCH_GRAMMAR } from './upstream-apply-patch.js';

describe('upstream apply_patch contract', () => {
  it('parses add, update, delete, move, and environment-id operations', () => {
    const result = parseUpstreamApplyPatch(
      [
        '*** Begin Patch',
        '*** Environment ID: local',
        '*** Add File: new.txt',
        '+hello',
        '*** Update File: old.txt',
        '*** Move to: moved.txt',
        '@@',
        '-before',
        '+after',
        '*** Delete File: remove.txt',
        '*** End Patch',
      ].join('\n'),
    );

    expect(result).toEqual({
      operations: [
        { type: 'create_file', path: 'new.txt', diff: '+hello' },
        { type: 'update_file', path: 'old.txt', moveTo: 'moved.txt', diff: '@@\n-before\n+after' },
        { type: 'delete_file', path: 'remove.txt', diff: '' },
      ],
    });
    expect(
      extractPatchPaths(
        [
          '*** Begin Patch',
          '*** Update File: old.txt',
          '*** Move to: moved.txt',
          '@@',
          '-before',
          '+after',
          '*** End Patch',
        ].join('\n'),
      ),
    ).toEqual(['old.txt', 'moved.txt']);
  });

  it('accepts the lenient heredoc wrapper used by upstream compatibility parsing', () => {
    expect(
      parseUpstreamApplyPatch("<<'PATCH'\n*** Begin Patch\n*** Delete File: old.txt\n*** End Patch\nPATCH"),
    ).toEqual({ operations: [{ type: 'delete_file', path: 'old.txt', diff: '' }] });
  });

  it('rejects incomplete or empty patches', () => {
    expect(() => parseUpstreamApplyPatch('*** Begin Patch\n*** End Patch')).toThrow('no file operations');
    expect(() => parseUpstreamApplyPatch('*** Begin Patch\n*** Add File: x\n+ok')).toThrow('*** End Patch');
  });

  it('exports the upstream grammar as a Lark custom-tool definition', () => {
    expect(UPSTREAM_APPLY_PATCH_GRAMMAR).toContain('start: begin_patch hunk+ end_patch');
    expect(UPSTREAM_APPLY_PATCH_GRAMMAR).toContain('*** Add File: ');
    expect(UPSTREAM_APPLY_PATCH_GRAMMAR).toContain('*** Move to: ');
  });
});
