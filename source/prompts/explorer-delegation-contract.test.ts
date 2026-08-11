import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readPrompt = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

describe('parent-facing explorer delegation contract', () => {
  it.each(['gpt-5.6.md', 'kimi.md'])('%s limits explorer to bounded evidence collection', (file) => {
    const prompt = readPrompt(file);

    expect(prompt).toContain('collect evidence for a bounded question');
    expect(prompt).toContain('retain responsibility for analysis, diagnosis, and recommendations');
  });

  it('keeps plan synthesis with the parent', () => {
    const prompt = readPrompt('plan-mode-info.md');

    expect(prompt).toContain('each scoped to a distinct evidence request');
    expect(prompt).toContain('Synthesize their findings yourself');
    expect(prompt).not.toContain('available for delegated investigation');
  });
});
