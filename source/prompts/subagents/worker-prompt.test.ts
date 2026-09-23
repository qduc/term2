import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';

const workerPrompt = fs.readFileSync(path.join(import.meta.dirname, 'worker.md'), 'utf-8');
const explorerPrompt = fs.readFileSync(path.join(import.meta.dirname, 'explorer.md'), 'utf-8');

it('worker prompt scales validation to behavioral impact while retaining required checks', () => {
  const lower = workerPrompt.toLowerCase();
  expect(lower).toContain('validation command');
  expect(lower).toContain('project-required checks');
  expect(lower).toContain('for inert changes such as docs or comments');
  expect(lower).toContain('diff review is sufficient');
  expect(lower).toContain('why no command was needed');
  expect(lower).not.toContain('you still need to run a validation command');
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
  for (const prompt of [workerPrompt, explorerPrompt]) {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('ask_orchestrator');
    expect(lower).toContain('genuine blocker');
    expect(lower).toContain('decision needed');
    expect(lower).toContain('continue after');
    expect(lower).toContain('do not contact the user');
  }
});

it('explorer prompt names web tools directly instead of routing through unregistered run_code', () => {
  expect(explorerPrompt).toContain('Use `web_search` to find relevant external documentation');
  expect(explorerPrompt).toContain('Use `web_fetch` to retrieve the content of specific URLs');
  expect(explorerPrompt).not.toContain('Inside `run_code`, use `tools.web_search`');
  expect(explorerPrompt).not.toContain('Inside `run_code`, use `tools.web_fetch`');
});
