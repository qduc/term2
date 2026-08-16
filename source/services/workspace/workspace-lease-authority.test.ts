import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionContext } from '../execution-context.js';
import { publishActiveWorkspaceRoot } from './active-workspace-root.js';
import { analyzePathRisk } from '../../utils/shell/command-safety/path-analysis.js';
import { SafetyStatus } from '../../utils/shell/command-safety/index.js';
import { createSandboxRuntimeConfig } from '../../utils/shell/sandbox/sandbox-policy.js';

afterEach(() => {
  publishActiveWorkspaceRoot(undefined);
});

it('sandbox allowWrite follows the leased root when cwd is omitted', () => {
  const leased = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-workspace-lease-'));
  const comparison = fs.realpathSync(process.cwd());
  const context = new ExecutionContext();

  try {
    context.enterWorkspace(leased);

    const config = createSandboxRuntimeConfig();

    expect(config.filesystem.allowWrite).toContain(fs.realpathSync(leased));
    expect(config.filesystem.allowWrite).not.toContain(comparison);
  } finally {
    context.exitWorkspace();
    fs.rmSync(leased, { recursive: true, force: true });
  }
});

it('command path classification follows the leased root when no cwd is supplied', () => {
  const comparison = fs.realpathSync(process.cwd());
  const leased = fs.mkdtempSync(path.join(path.dirname(comparison), '.term2-workspace-lease-'));
  const context = new ExecutionContext();

  try {
    context.enterWorkspace(leased);

    expect(analyzePathRisk(path.join(leased, 'src', 'main.ts'))).toBe(SafetyStatus.GREEN);
    expect(analyzePathRisk(path.join(comparison, 'outside-project.txt'))).toBe(SafetyStatus.YELLOW);
  } finally {
    context.exitWorkspace();
    fs.rmSync(leased, { recursive: true, force: true });
  }
});
