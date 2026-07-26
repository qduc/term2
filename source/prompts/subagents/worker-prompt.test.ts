import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';

const workerPrompt = fs.readFileSync(path.join(import.meta.dirname, 'worker.md'), 'utf-8');
const researcherPrompt = fs.readFileSync(path.join(import.meta.dirname, 'researcher.md'), 'utf-8');

it('worker prompt still requires running a validation command', () => {
  const lower = workerPrompt.toLowerCase();
  expect(lower).toContain('validation command');
});

it('worker prompt notes that validation and diff stat are auto-captured', () => {
  const lower = workerPrompt.toLowerCase();
  expect(lower).toContain('automatically captures');
  expect(lower).toContain('diff stat');
  expect(lower).toContain('do not need to paste the full output');
});

it('worker prompt mentions that shell-driven edits may not appear in diff stat', () => {
  const lower = workerPrompt.toLowerCase();
  expect(lower).toContain('shell-driven edits');
  expect(lower).toContain('may not appear');
});

it('execution role prompts reserve ask_orchestrator for genuine blockers and never direct user contact', () => {
  for (const prompt of [workerPrompt, researcherPrompt]) {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('ask_orchestrator');
    expect(lower).toContain('genuine blocker');
    expect(lower).toContain('decision needed');
    expect(lower).toContain('continue after');
    expect(lower).toContain('do not contact the user');
  }
});
