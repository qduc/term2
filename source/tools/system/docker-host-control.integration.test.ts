import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../../services/service-interfaces.js';
import {
  grantDockerHostControl,
  resetDockerHostControlGrantsForTests,
} from '../../utils/shell/sandbox/docker-host-control-grants.js';
import {
  createDockerHostControl,
  DOCKER_HOST_CONTROL_RETRY_INSTRUCTION,
} from '../../utils/shell/sandbox/docker-host-control.js';
import { getDefaultShellSandboxRunner } from '../../utils/shell/sandbox/shell-sandbox-runner.js';
import { createShellToolDefinition } from './shell.js';

const createNoopLogger = (): ILoggingService => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
});

function dockerDesktopPrerequisite(): string | undefined {
  if (process.platform !== 'darwin') return 'Docker host control is currently supported only on macOS.';
  const dockerCli = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (dockerCli.error) return `Docker CLI is unavailable: ${dockerCli.error.message}`;
  try {
    const control = createDockerHostControl();
    control.cleanup();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  // This opt-in harness is useful only when it can prove the granted command
  // reached Docker. A non-mutating daemon probe makes an unavailable Desktop
  // installation a documented skip rather than a misleading test failure.
  const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (daemon.error) return `Docker daemon is unavailable: ${daemon.error.message}`;
  if (daemon.status !== 0) return 'Docker daemon is unavailable.';

  return undefined;
}

const enabled = process.env.RUN_DOCKER_HOST_CONTROL_INTEGRATION === '1';
const prerequisite = enabled
  ? dockerDesktopPrerequisite()
  : 'set RUN_DOCKER_HOST_CONTROL_INTEGRATION=1 to run this opt-in test';

if (prerequisite) {
  it.skip(`Docker Desktop host-control integration skipped: ${prerequisite}`, () => {});
} else {
  it.sequential('docker version requires an explicit grant and succeeds after one is issued', async ({ skip }) => {
    const runner = getDefaultShellSandboxRunner();
    const availability = await runner.availability();
    if (availability.type !== 'available') {
      skip(
        `Docker Desktop host-control integration unavailable: ${availability.type}${
          'reason' in availability ? `: ${availability.reason}` : ''
        }`,
      );
    }

    const sessionId = 'docker-desktop-integration';
    const tool = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
      shellSandboxRunner: runner,
    });
    const context = { context: { sessionId } };

    try {
      const blocked = await tool.execute({ command: 'docker version' }, context);
      expect(blocked).toContain('requires explicit approval');

      grantDockerHostControl({ command: 'docker version', cwd: process.cwd(), scope: 'once', sessionId });
      const granted = await tool.execute({ command: 'docker version', timeout_ms: 20_000 }, context);
      expect(granted).toContain('exit 0');

      // Regression: a subshell prefix used to hide the invocation from detection,
      // so the command ran sandboxed and Docker fell back to the denied
      // /var/run/docker.sock default context.
      const wrapped = "(docker version 2>&1 || true) && printf 'done\\n'";
      expect(await tool.execute({ command: wrapped }, context)).toContain('requires explicit approval');
      grantDockerHostControl({ command: wrapped, cwd: process.cwd(), scope: 'once', sessionId });
      const grantedWrapped = await tool.execute({ command: wrapped, timeout_ms: 20_000 }, context);
      expect(grantedWrapped).not.toContain('permission denied');
    } finally {
      resetDockerHostControlGrantsForTests();
    }
  });

  it.sequential('a Docker call the command string hides is blocked, then approvable', async ({ skip }) => {
    const runner = getDefaultShellSandboxRunner();
    const availability = await runner.availability();
    if (availability.type !== 'available') {
      skip(`Docker Desktop host-control integration unavailable: ${availability.type}`);
    }

    // `sh -c` stands in for a script, make target, or package command that
    // reaches Docker internally: no command-string check can see it.
    const indirect = `sh -c 'docker version --format "{{.Server.Version}}"'`;
    const sessionId = 'docker-desktop-indirect';
    const tool = createShellToolDefinition({
      loggingService: createNoopLogger(),
      settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
      shellSandboxRunner: runner,
    });
    const context = { context: { sessionId } };

    try {
      expect(await tool.needsApproval({ command: indirect }, context)).toBe(false);
      expect(await tool.execute({ command: indirect, timeout_ms: 20_000 }, context)).toContain(
        DOCKER_HOST_CONTROL_RETRY_INSTRUCTION,
      );

      // The blocked run is what makes the retry approvable.
      expect(await tool.needsApproval({ command: indirect }, context)).toBe(true);

      // Approval leaves the pending block in place; only the run that uses it
      // clears it. Granting here mirrors prepareContinuation exactly.
      grantDockerHostControl({ command: indirect, cwd: process.cwd(), scope: 'once', sessionId });
      expect(await tool.execute({ command: indirect, timeout_ms: 20_000 }, context)).toContain('exit 0');
      expect(await tool.needsApproval({ command: indirect }, context)).toBe(false);
    } finally {
      resetDockerHostControlGrantsForTests();
    }
  });
}
