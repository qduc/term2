import { afterEach, expect, it } from 'vitest';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import {
  configureDockerHostControlGrants,
  consumeDockerHostControlOnce,
  grantDockerHostControl,
  hasDockerHostControlProject,
  hasDockerHostControlSession,
  resetDockerHostControlGrantsForTests,
} from './docker-host-control-grants.js';

afterEach(resetDockerHostControlGrantsForTests);

it('consumes one-shot Docker grants only for the exact command', () => {
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'once' });
  expect(consumeDockerHostControlOnce('docker images')).toBe(false);
  expect(consumeDockerHostControlOnce('docker ps')).toBe(true);
  expect(consumeDockerHostControlOnce('docker ps')).toBe(false);
});

it('keeps session grants in memory by workspace root and persists project grants through settings', () => {
  const settings = createMockSettingsService();
  configureDockerHostControlGrants(settings);
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'session' });
  expect(hasDockerHostControlSession(process.cwd())).toBe(true);
  grantDockerHostControl({ command: 'docker ps', cwd: process.cwd(), scope: 'project' });
  expect(hasDockerHostControlProject(process.cwd())).toBe(true);
});
