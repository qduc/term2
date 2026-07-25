import { afterEach, expect, it } from 'vitest';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import {
  clearDockerHostControlSession,
  configureDockerHostControlGrants,
  consumeDockerHostControlOnce,
  grantDockerHostControl,
  hasDockerHostControlProject,
  hasDockerHostControlSession,
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
