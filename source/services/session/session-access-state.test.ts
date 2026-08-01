import { expect, it } from 'vitest';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { SessionAccessState } from './session-access-state.js';

it('disposes read and transient Docker grants while retaining the settings-backed project grant', () => {
  const settings = createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] });
  const access = new SessionAccessState(settings);

  access.allowReadFolder('/outside/docs');
  access.grantDocker('docker ps', process.cwd(), 'once');
  access.grantDocker('docker ps', process.cwd(), 'project');
  access.recordDockerDenial('indirect-command');
  access.dispose();

  expect(access.allowsRead('/outside/docs/guide.md')).toBe(false);
  expect(access.hasDockerGrant('docker ps', process.cwd())).toBe(true);
  expect(access.requiresDockerApproval('indirect-command')).toBe(false);
  expect(settings.get('sandbox.dockerHostControlProjects')).toContain(process.cwd());
});

it('clears transient read and Docker state without removing the settings-backed project grant', () => {
  const settings = createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] });
  const access = new SessionAccessState(settings);

  access.allowReadFolder('/outside/docs');
  access.grantDocker('indirect-command', process.cwd(), 'once');
  access.grantDocker('docker ps', process.cwd(), 'session');
  access.grantDocker('docker ps', process.cwd(), 'project');
  access.recordDockerDenial('indirect-command');
  access.clearTransient();

  expect(access.allowsRead('/outside/docs/guide.md')).toBe(false);
  expect(access.hasDockerGrant('indirect-command', `${process.cwd()}/not-project`)).toBe(false);
  expect(access.hasDockerSessionGrant(process.cwd())).toBe(false);
  expect(access.requiresDockerApproval('indirect-command')).toBe(false);
  expect(access.hasDockerProject(process.cwd())).toBe(true);
});
