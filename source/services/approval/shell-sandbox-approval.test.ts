import { it, expect } from 'vitest';
import { isUnsandboxedShell, requiresHumanShellApproval } from './shell-sandbox-approval.js';

const sessionAccess = {
  requiresDockerApproval: (command: string) => command.includes('docker'),
} as any;

it('isUnsandboxedShell recognizes shell and bash with unsandboxed sandbox', () => {
  expect(isUnsandboxedShell('shell', { command: 'curl x', sandbox: 'unsandboxed' })).toBe(true);
  expect(isUnsandboxedShell('bash', { sandbox: 'unsandboxed' })).toBe(true);
});

it('isUnsandboxedShell rejects sandboxed calls and non-shell tools', () => {
  expect(isUnsandboxedShell('shell', { command: 'ls', sandbox: 'default' })).toBe(false);
  expect(isUnsandboxedShell('shell', { command: 'ls' })).toBe(false);
  expect(isUnsandboxedShell('read_file', { path: 'x', sandbox: 'unsandboxed' })).toBe(false);
  expect(isUnsandboxedShell(undefined, { sandbox: 'unsandboxed' })).toBe(false);
});

it('unsandboxed shell requires human approval by default (sandbox escape)', () => {
  expect(requiresHumanShellApproval('shell', { command: 'curl x', sandbox: 'unsandboxed' }, 's1', sessionAccess)).toBe(
    true,
  );
  expect(requiresHumanShellApproval('bash', { sandbox: 'unsandboxed' }, 's1', sessionAccess)).toBe(true);
});

it('unsandboxed shell can defer to LLM evaluation when opted in', () => {
  const opts = { llmMayEvaluateUnsandboxed: true };
  expect(
    requiresHumanShellApproval(
      'shell',
      { command: 'curl x', sandbox: 'unsandboxed' },
      's1',
      sessionAccess,
      undefined,
      opts,
    ),
  ).toBe(false);
  expect(requiresHumanShellApproval('bash', { sandbox: 'unsandboxed' }, 's1', sessionAccess, undefined, opts)).toBe(
    false,
  );
});

it('unsandboxed shell with explicit opt-out still requires human approval', () => {
  expect(
    requiresHumanShellApproval('shell', { command: 'curl x', sandbox: 'unsandboxed' }, 's1', sessionAccess, undefined, {
      llmMayEvaluateUnsandboxed: false,
    }),
  ).toBe(true);
});

it('docker host control requires human approval regardless of unsandboxed opt-in', () => {
  const opts = { llmMayEvaluateUnsandboxed: true };
  expect(requiresHumanShellApproval('shell', { command: 'docker ps' }, 's1', sessionAccess, undefined, opts)).toBe(
    true,
  );
  expect(
    requiresHumanShellApproval(
      'shell',
      { command: 'docker ps', sandbox: 'unsandboxed' },
      's1',
      sessionAccess,
      undefined,
      opts,
    ),
  ).toBe(true);
});

it('safe non-docker commands do not require human approval', () => {
  expect(requiresHumanShellApproval('shell', { command: 'ls' }, 's1', sessionAccess)).toBe(false);
});
