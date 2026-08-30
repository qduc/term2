import { it, expect } from 'vitest';
import path from 'path';
import { classifyCommand, classifyCommandDetailed, SafetyStatus } from './command-safety/index.js';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';

it('classifies rm targeting SANDBOX_TEMP_DIR as YELLOW', () => {
  const scratchFile = path.join(SANDBOX_TEMP_DIR, 'scratch-123.txt');
  const result = classifyCommand(`rm ${scratchFile}`);
  expect(result).toBe(SafetyStatus.YELLOW);

  const rfResult = classifyCommand(`rm -rf ${scratchFile}`);
  expect(rfResult).toBe(SafetyStatus.YELLOW);
});

it('classifies rm targeting session-created files as YELLOW when session tracking is present', () => {
  const createdPath = '/mock/workspace/created-in-session.ts';
  const options = {
    isSessionCreatedFile: (targetPath: string) => targetPath === createdPath,
  };

  const allowedResult = classifyCommandDetailed(`rm ${createdPath}`, undefined, options);
  expect(allowedResult.status).toBe(SafetyStatus.YELLOW);

  const nonCreatedPath = '/mock/workspace/existing-repo-file.ts';
  const blockedResult = classifyCommandDetailed(`rm ${nonCreatedPath}`, undefined, options);
  expect(blockedResult.status).toBe(SafetyStatus.RED);
});

it('classifies dangerous rm wildcard and root invocations as RED', () => {
  const dangerousCommands = [
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf ~/*',
    'rm -rf $HOME',
    'rm -rf *',
    'rm -rf .*',
    'rm -rf .',
    'rm -rf ..',
    'rm -rf ../outside',
    'rm',
    'rm -rf',
  ];

  for (const cmd of dangerousCommands) {
    expect(classifyCommand(cmd), `"${cmd}" must be classified as RED`).toBe(SafetyStatus.RED);
  }
});

it('classifies rm targeting system paths or sensitive files as RED', () => {
  const dangerousTargets = ['rm /etc/passwd', 'rm /usr/local/bin/node', 'rm .env', 'rm -rf .git', 'rm ~/.ssh/id_rsa'];

  for (const cmd of dangerousTargets) {
    expect(classifyCommand(cmd), `"${cmd}" must be classified as RED`).toBe(SafetyStatus.RED);
  }
});

it('classifies rmdir on scratch directories as YELLOW and dangerous rmdir as RED', () => {
  const scratchDir = path.join(SANDBOX_TEMP_DIR, 'scratch_dir');
  expect(classifyCommand(`rmdir ${scratchDir}`)).toBe(SafetyStatus.YELLOW);

  expect(classifyCommand('rmdir /')).toBe(SafetyStatus.RED);
  expect(classifyCommand('rmdir /etc')).toBe(SafetyStatus.RED);
});
