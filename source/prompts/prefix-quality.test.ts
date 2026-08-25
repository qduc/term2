import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { getAgentDefinition } from '../agent.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { PLAN_MODE_ENTER_NOTICE, primePlanModeNoticeIfActive } from '../services/mode-notices.js';
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
  expect(full).toContain('You are currently in **Plan Mode**.');
  expect(full).not.toContain('You are currently in **Standard Mode**');
  expect(PLAN_MODE_ENTER_NOTICE).toContain(PLAN_WORKFLOW_MARKER);
  expect(PLAN_MODE_ENTER_NOTICE).toContain('You are currently in **Plan Mode**.');
});

it('primes the enter notice when a session starts already in Plan Mode', () => {
  const queued: string[] = [];
  primePlanModeNoticeIfActive(false, (text) => queued.push(text));
  expect(queued).toEqual([]);
  primePlanModeNoticeIfActive(true, (text) => queued.push(text));
  expect(queued).toEqual([PLAN_MODE_ENTER_NOTICE]);
});

it('instruction prefix stays on the stub in both modes; the workflow rides on the enter notice', async () => {
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
    expect(plan.instructions).toContain(STUB_STANDARD_MARKER);
    expect(standard.instructions).not.toContain(PLAN_WORKFLOW_MARKER);
    expect(plan.instructions).not.toContain(PLAN_WORKFLOW_MARKER);
    expect(plan.instructions).toBe(standard.instructions);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('product-controlled prefix does not attach the Plan Mode workflow file', () => {
  const standard = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: false });
  const plan = buildPromptSpec({ model: 'gpt-4o', liteMode: false, planMode: true });

  expect(standard.fragmentFiles).toContain('plan-mode-stub.md');
  expect(standard.fragmentFiles).not.toContain('plan-mode-info.md');
  expect(plan.fragmentFiles).toEqual(standard.fragmentFiles);

  const stubBytes = readPrompt('plan-mode-stub.md').length;
  const fullBytes = readPrompt('plan-mode-info.md').length;
  expect(stubBytes).toBeLessThan(fullBytes / 2);
});
