import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readPrompt = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

describe('parent-facing explorer delegation contract', () => {
  it.each(['gpt-5.6.md', 'kimi.md'])('%s limits explorer to bounded evidence collection', (file) => {
    const prompt = readPrompt(file);

    expect(prompt).toContain('collect evidence for a bounded question');
    expect(prompt).toContain('retain responsibility for analysis, diagnosis, and recommendations');
    expect(prompt).toContain('breadth or depth, never both');
  });

  it('keeps plan synthesis with the parent', () => {
    const prompt = readPrompt('plan-mode-info.md');

    expect(prompt).toContain('each scoped to a distinct evidence request');
    expect(prompt).toContain('breadth or depth, never both');
    expect(prompt).toContain('Synthesize their findings yourself');
    expect(prompt).not.toContain('available for delegated investigation');
  });

  it('requires one objective, ownership boundary, and done condition for every delegated task', () => {
    const prompt = readPrompt('orchestrator.md');

    expect(prompt).toContain('one clear objective, one ownership boundary, and one concrete done condition');
  });

  it('gives each role its own scope discipline', () => {
    const orchestrator = readPrompt('orchestrator.md');
    const explorer = readPrompt('subagents/explorer.md');
    const worker = readPrompt('subagents/worker.md');
    const mentor = readPrompt('subagents/mentor.md');
    const librarian = readPrompt('subagents/librarian.md');

    expect(orchestrator).toContain('breadth or depth, never both');
    expect(explorer).toContain('breadth or depth, never both');
    expect(worker).toContain('one cohesive implementation unit');
    expect(mentor).toContain('one decision or challenge question');
    expect(librarian).toContain('one retrieval objective or memory-maintenance topic boundary');
  });
});
