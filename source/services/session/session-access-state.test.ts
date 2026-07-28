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
  expect(settings.get<string[]>('sandbox.dockerHostControlProjects')).toContain(process.cwd());
});
