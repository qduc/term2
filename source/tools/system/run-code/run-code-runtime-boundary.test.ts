import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('run_code product/runtime dependency boundary', () => {
  it('keeps the runtime and lifecycle contract independent of the outer tool module', () => {
    expect(source('run-code-runtime.ts')).not.toMatch(
      /(?:from|import\()\s*['"].*run-code\.js['"]|import\s+['"].*run-code\.js['"]/,
    );
    expect(source('run-code-runtime-contract.ts')).not.toMatch(/run-code\.js/);
    expect(source('run-code-runtime-contract.ts')).not.toMatch(/run-code-runtime\.js/);
  });
});
