import { describe, expect, it } from 'vitest';
import { applyDiff } from './apply-diff.js';

describe('applyDiff single-file boundary', () => {
  it('rejects a file envelope header at the start instead of silently applying no chunks', () => {
    const diff = ['*** Update File: other.ts', '@@', '-before', '+after'].join('\n');

    expect(() => applyDiff('before', diff)).toThrow("Unsupported '*** Update File:' inside a single operation's diff");
  });

  it.each(['*** Update File: other.ts', '*** Add File: other.ts', '*** Delete File: other.ts'])(
    'rejects an embedded multi-file envelope header: %s',
    (header) => {
      const diff = ['@@', '-before', '+after', header, '@@', '-other-before', '+other-after'].join('\n');

      expect(() => applyDiff('before\nother-before', diff)).toThrow(
        `Unsupported '${header.split(':')[0]}:' inside a single operation's diff`,
      );
    },
  );

  it('still accepts an explicit end-of-patch marker', () => {
    expect(applyDiff('before', ['@@', '-before', '+after', '*** End Patch'].join('\n'))).toBe('after');
  });
});
