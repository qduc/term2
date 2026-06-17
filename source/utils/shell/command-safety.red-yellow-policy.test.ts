import { it, expect } from 'vitest';
import { analyzePathRisk } from './command-safety/path-analysis.js';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';

it('ambiguous command families are YELLOW instead of RED', () => {
  const commands = [
    'npm install',
    'curl https://example.com',
    'cp source.txt dest.txt',
    'mv old.txt new.txt',
    'ssh example.com',
    'chmod +x script.sh',
    'pip install requests',
  ];

  for (const command of commands) {
    expect(classifyCommand(command), `"${command}" should let the model decide`).toBe(SafetyStatus.YELLOW);
  }
});

it('inherently dangerous direct commands remain RED', () => {
  const commands = ['rm -rf /', 'mkfs /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'sudo rm -rf /', 'shutdown now'];

  for (const command of commands) {
    expect(classifyCommand(command), `"${command}" should be hard-blocked`).toBe(SafetyStatus.RED);
  }
});

it('read-only risky paths are YELLOW, not hard-blocked', () => {
  const paths = ['/etc/passwd', '/var/log/system.log', '../secrets.json'];

  for (const path of paths) {
    expect(analyzePathRisk(path), `"${path}" should require model/user review`).toBe(SafetyStatus.YELLOW);
  }
});

it('workspace-scale edit commands are YELLOW instead of RED', () => {
  const commands = ['sed -i "s/foo/bar/" source.txt', 'find . -exec cp {} /tmp/backup \\;'];

  for (const command of commands) {
    expect(classifyCommand(command), `"${command}" should let the model decide`).toBe(SafetyStatus.YELLOW);
  }
});
