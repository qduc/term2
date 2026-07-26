import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';

const orchestratorPrompt = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.md'), 'utf-8');

it('orchestrator prompt keeps the orchestrator as the single point of contact that owns the outcome', () => {
  expect(orchestratorPrompt).toContain('single point of contact');
  expect(orchestratorPrompt).toContain('Delegation transfers execution, never outcome ownership');
});

it('orchestrator prompt gives the orchestrator standing to overrule a subagent recommendation', () => {
  const lower = orchestratorPrompt.toLowerCase();

  expect(lower).toContain('your judgement governs');
  expect(lower).toContain('advise and execute; they do not decide');
  // The mentor must stay a challenger rather than become the decision-maker.
  expect(lower).toContain('challenge your plan');
});

it('orchestrator prompt tells the orchestrator to state disagreement with the user before proceeding', () => {
  const lower = orchestratorPrompt.toLowerCase();

  expect(lower).toContain('state your recommendation');
  expect(lower).toContain('proceed as the user directs');
});

it('orchestrator prompt requires the final report to be the orchestrator’s own, not a forwarded summary', () => {
  const lower = orchestratorPrompt.toLowerCase();

  expect(lower).toContain('in your own voice');
  expect(lower).toContain('never a substitute for it');
});

it('orchestrator prompt documents get_subagent_status as the non-blocking mid-run peek', () => {
  const lower = orchestratorPrompt.toLowerCase();

  expect(lower).toContain('get_subagent_status');
  expect(lower).toContain('non-blocking');
  expect(lower).toContain('what is it doing');
});

it('orchestrator prompt keeps peek from substituting for the async completion discipline', () => {
  const lower = orchestratorPrompt.toLowerCase();

  // Peek must not become a reason to poll in a loop or replace completion evidence.
  expect(lower).toContain('not a substitute');
  expect(lower).toContain('get_subagent_result');
  expect(lower).toContain('completion notification');
});
