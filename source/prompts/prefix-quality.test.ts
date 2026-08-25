import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { getAgentDefinition } from '../agent.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { buildPromptSpec } from './prompt-constructor.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
} as any;

const readPrompt = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

const PLAN_WORKFLOW_MARKER = 'Plan Mode Workflow';
const STUB_STANDARD_MARKER = 'You are currently in **Standard Mode**. Full Plan Mode workflow instructions';

it('plan-mode stub is smaller than the full workflow and still names the live constraints', () => {
  const stub = readPrompt('plan-mode-stub.md');
  const full = readPrompt('plan-mode-info.md');

  expect(stub.length).toBeLessThan(full.length / 2);
  expect(stub).toContain('<system-notice>');
  expect(stub).toContain('do not create or modify files');
  expect(stub).toContain('write-capable subagents');
  expect(stub).toContain(STUB_STANDARD_MARKER);
  expect(stub).not.toContain(PLAN_WORKFLOW_MARKER);
  expect(stub).not.toContain('Acceptance criteria');

  expect(full).toContain(PLAN_WORKFLOW_MARKER);
  expect(full).toContain('Synthesize their findings yourself');
  expect(full).toContain('Acceptance criteria');
});

it('standard sessions omit the Plan Mode workflow body; plan-mode sessions keep it', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'term2-prefix-quality-'));
  const executionContext = {
    isRemote: () => false,
    getCwd: () => cwd,
  } as any;

  try {
    const standard = getAgentDefinition({
      settingsService: createMockSettingsService({
        'agent.model': 'gpt-4o',
        'app.planMode': false,
      }),
      loggingService: mockLogger,
      executionContext,
    });
    const plan = getAgentDefinition({
      settingsService: createMockSettingsService({
        'agent.model': 'gpt-4o',
        'app.planMode': true,
      }),
      loggingService: mockLogger,
      executionContext,
    });

    expect(standard.instructions).toContain(STUB_STANDARD_MARKER);
    expect(standard.instructions).not.toContain(PLAN_WORKFLOW_MARKER);
    expect(plan.instructions).toContain(PLAN_WORKFLOW_MARKER);
    expect(plan.instructions).toContain('Synthesize their findings yourself');
    expect(plan.instructions.length).toBeGreaterThan(standard.instructions.length);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('product-controlled standard prefix stays below the plan-mode prefix for the same model', () => {
  const standard = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: false });
  const plan = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: true });

  expect(standard.fragmentFiles).toContain('plan-mode-stub.md');
  expect(standard.fragmentFiles).not.toContain('plan-mode-info.md');
  expect(plan.fragmentFiles).toContain('plan-mode-info.md');
  expect(plan.fragmentFiles).not.toContain('plan-mode-stub.md');

  const standardBytes = standard.fragmentFiles.reduce((sum, file) => sum + readPrompt(file).length, 0);
  const planBytes = plan.fragmentFiles.reduce((sum, file) => sum + readPrompt(file).length, 0);
  expect(standardBytes).toBeLessThan(planBytes);
});
