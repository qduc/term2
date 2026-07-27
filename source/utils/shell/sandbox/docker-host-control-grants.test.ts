import { afterEach, expect, it } from 'vitest';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import {
  clearDockerHostControlSession,
  configureDockerHostControlGrants,
  consumeDockerHostControlDenial,
  consumeDockerHostControlOnce,
  grantDockerHostControl,
  hasDockerHostControlProject,
  hasDockerHostControlSession,
  recordDockerHostControlDenial,
  requiresDockerHostControlApproval,
  resetDockerHostControlGrantsForTests,
} from './docker-host-control-grants.js';

afterEach(resetDockerHostControlGrantsForTests);

it('consumes one-shot Docker grants only for the exact command in the granting session', () => {
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'once', sessionId: 'session-a' });

  expect(consumeDockerHostControlOnce('session-b', 'docker ps')).toBe(false);
  expect(consumeDockerHostControlOnce('session-a', 'docker images')).toBe(false);
  expect(consumeDockerHostControlOnce('session-a', 'docker ps')).toBe(true);
  expect(consumeDockerHostControlOnce('session-a', 'docker ps')).toBe(false);
});

it('treats a command the sandbox blocked from Docker as needing host-control approval', () => {
  // Docker reached from a script never mentions docker in the command string,
  // so the blocked run is what makes the approval prompt reachable.
  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(false);

  recordDockerHostControlDenial('session-a', 'pnpm test');

  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(true);
  expect(requiresDockerHostControlApproval('session-a', 'pnpm build')).toBe(false);
});

it('forgets a blocked command once its approval decision has been acted on', () => {
  recordDockerHostControlDenial('session-a', 'pnpm test');

  expect(consumeDockerHostControlDenial('session-a', 'pnpm test')).toBe(true);
  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(false);
  expect(consumeDockerHostControlDenial('session-a', 'pnpm test')).toBe(false);
});

it('does not force host-control approval in another session because of a denial recorded elsewhere', () => {
  recordDockerHostControlDenial('session-a', 'pnpm test');

  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(true);
  expect(requiresDockerHostControlApproval('session-b', 'pnpm test')).toBe(false);
});

it('settles a denial only in the session that acts on it', () => {
  recordDockerHostControlDenial('session-a', 'pnpm test');
  recordDockerHostControlDenial('session-b', 'pnpm test');

  expect(consumeDockerHostControlDenial('session-a', 'pnpm test')).toBe(true);

  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(false);
  expect(requiresDockerHostControlApproval('session-b', 'pnpm test')).toBe(true);
});

it('clearing a session forgets its Docker denials without touching other sessions', () => {
  recordDockerHostControlDenial('session-a', 'pnpm test');
  recordDockerHostControlDenial('session-b', 'pnpm test');

  clearDockerHostControlSession('session-a');

  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(false);
  expect(requiresDockerHostControlApproval('session-b', 'pnpm test')).toBe(true);
});

it('still requires host-control approval for a lexical Docker invocation in any session', () => {
  // Per-session denial scoping must not weaken the session-independent check.
  expect(requiresDockerHostControlApproval('session-b', 'docker ps')).toBe(true);
  expect(requiresDockerHostControlApproval(undefined, 'docker ps')).toBe(true);
});

it('cannot record or consult a denial without a session, and never falls back to global scope', () => {
  // Fails closed: an unattributable block is simply not remembered, so it can
  // never hand host-control to a session that did not earn it.
  recordDockerHostControlDenial(undefined, 'pnpm test');

  expect(requiresDockerHostControlApproval(undefined, 'pnpm test')).toBe(false);
  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(false);

  recordDockerHostControlDenial('session-a', 'pnpm test');
  expect(requiresDockerHostControlApproval(undefined, 'pnpm test')).toBe(false);
  expect(consumeDockerHostControlDenial(undefined, 'pnpm test')).toBe(false);
  expect(requiresDockerHostControlApproval('session-a', 'pnpm test')).toBe(true);
});

it('keeps session grants isolated by session identity even when sessions share a workspace', () => {
  const cwd = process.cwd();
  grantDockerHostControl({ command: 'docker ps', cwd, scope: 'session', sessionId: 'session-a' });

  expect(hasDockerHostControlSession('session-a', cwd)).toBe(true);
  expect(hasDockerHostControlSession('session-b', cwd)).toBe(false);
});

it('clearing one session leaves other sessions and persistent project grants intact', () => {
  const settings = createMockSettingsService();
  configureDockerHostControlGrants(settings);
  const cwd = process.cwd();
  grantDockerHostControl({ command: 'docker ps', cwd, scope: 'session', sessionId: 'session-a' });
  grantDockerHostControl({ command: 'docker ps', cwd, scope: 'session', sessionId: 'session-b' });
  grantDockerHostControl({ command: 'docker ps', cwd, scope: 'project', sessionId: 'session-a' });

  clearDockerHostControlSession('session-a');

  expect(hasDockerHostControlSession('session-a', cwd)).toBe(false);
  expect(hasDockerHostControlSession('session-b', cwd)).toBe(true);
  expect(hasDockerHostControlProject(cwd)).toBe(true);
});
