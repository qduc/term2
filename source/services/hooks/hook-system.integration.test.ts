import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { HookService } from './hook-service.js';
import { HookRegistry } from './hook-registry.js';
import { discoverHookFiles } from './hook-discovery.js';
import type { Term2HookEvent } from './hook-contracts.js';

describe('Hook System Integration', () => {
  const testDir = join(tmpdir(), `term2-hooks-integration-${Date.now()}`);
  const userHome = join(testDir, 'user-home');
  const userHookDir = join(userHome, '.term2', 'hooks');
  const projectDir = join(testDir, 'project-workspace');
  const projectHookDir = join(projectDir, '.term2', 'hooks');

  beforeEach(async () => {
    await mkdir(userHookDir, { recursive: true });
    await mkdir(projectHookDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('handles project trust filtering correctly during discovery and startup', async () => {
    // Write user hook
    await writeFile(
      join(userHookDir, '01-user.js'),
      'export default function(term2) { globalThis.__hook_user_loaded = true; }',
      'utf8',
    );

    // Write project hook
    await writeFile(
      join(projectHookDir, '02-project.js'),
      'export default function(term2) { globalThis.__hook_project_loaded = true; }',
      'utf8',
    );

    // Test untrusted project root
    const untrustedDiscovery = await discoverHookFiles({
      cwd: projectDir,
      homeDir: userHome,
      userEnabled: true,
      projectEnabled: true,
      trustedProjectRoots: [], // Not trusted
    });

    expect(untrustedDiscovery.files.map((f) => f.scope)).toEqual(['user']);
    expect(untrustedDiscovery.diagnostics.some((d) => d.code === 'project_hooks_untrusted')).toBe(true);

    // Test trusted project root
    const trustedDiscovery = await discoverHookFiles({
      cwd: projectDir,
      homeDir: userHome,
      userEnabled: true,
      projectEnabled: true,
      trustedProjectRoots: [projectDir], // Trusted
    });

    expect(trustedDiscovery.files.map((f) => f.scope)).toEqual(['user', 'project']);
  });

  it('dispatches session.start, approval events, and session.end in complete lifecycle sequence', async () => {
    const events: Term2HookEvent[] = [];
    const registry = new HookRegistry();

    registry.register({ path: 'test-hook.js', scope: 'user' }, (term2) => {
      term2.on('session.start', async (event) => {
        events.push(event);
      });
      term2.on('approval.requested', async (event) => {
        events.push(event);
      });
      term2.on('approval.resolved', async (event) => {
        events.push(event);
      });
      term2.on('session.end', async (event) => {
        events.push(event);
      });
    });

    const hookService = new HookService({ registry });

    // 1. Session start event (interactive mode)
    await hookService.emit({
      type: 'session.start',
      schemaVersion: 1,
      eventId: 'evt-1',
      sessionId: 'sess-123',
      timestamp: Date.now(),
      scope: 'root',
      cwd: projectDir,
      mode: 'interactive',
      providerName: 'openai',
      modelName: 'gpt-4o',
    });

    // 2. Approval requested event
    await hookService.emit({
      type: 'approval.requested',
      schemaVersion: 1,
      eventId: 'evt-2',
      sessionId: 'sess-123',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      timestamp: Date.now(),
      scope: 'root',
      toolName: 'run_command',
      normalizedArguments: { CommandLine: 'ls' },
      approvalKind: 'tool',
      proposedDecision: 'approve',
    });

    // 3. Approval resolved event (user approved)
    await hookService.emit({
      type: 'approval.resolved',
      schemaVersion: 1,
      eventId: 'evt-3',
      sessionId: 'sess-123',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      timestamp: Date.now(),
      scope: 'root',
      resolution: 'approved',
      source: 'user',
      executionFollowed: true,
    });

    // 4. Session end event
    await hookService.emit({
      type: 'session.end',
      schemaVersion: 1,
      eventId: 'evt-4',
      sessionId: 'sess-123',
      timestamp: Date.now(),
      scope: 'root',
      reason: 'normal',
      sessionDuration: 1500,
    });

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('session.start');
    expect(events[1].type).toBe('approval.requested');
    expect(events[2].type).toBe('approval.resolved');
    expect(events[3].type).toBe('session.end');

    // Shutdown hook service and verify subsequent events are ignored
    await hookService.shutdown();

    await hookService.emit({
      type: 'session.start',
      schemaVersion: 1,
      eventId: 'evt-5',
      sessionId: 'sess-123',
      timestamp: Date.now(),
      scope: 'root',
      cwd: projectDir,
      mode: 'interactive',
      providerName: 'openai',
      modelName: 'gpt-4o',
    });

    expect(events).toHaveLength(4); // No new events delivered post-shutdown
  });

  it('differentiates auto-approval from prompt-driven approval events', async () => {
    const events: Term2HookEvent[] = [];
    const registry = new HookRegistry();

    registry.register({ path: 'auto-app-hook.js', scope: 'user' }, (term2) => {
      term2.on('approval.requested', async (event) => {
        events.push(event);
      });
      term2.on('approval.resolved', async (event) => {
        events.push(event);
      });
    });

    const hookService = new HookService({ registry });

    // Auto-approved tool call emits approval.resolved with source 'policy' and NO preceding approval.requested
    await hookService.emit({
      type: 'approval.resolved',
      schemaVersion: 1,
      eventId: 'evt-auto-1',
      sessionId: 'sess-123',
      turnId: 'turn-1',
      toolCallId: 'call-auto-1',
      timestamp: Date.now(),
      scope: 'root',
      resolution: 'auto_approved',
      source: 'policy',
      executionFollowed: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('approval.resolved');
    if (events[0].type === 'approval.resolved') {
      expect(events[0].resolution).toBe('auto_approved');
      expect(events[0].source).toBe('policy');
    }
  });
});
