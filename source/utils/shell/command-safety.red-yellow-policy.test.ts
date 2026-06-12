import test from 'ava';
import { analyzePathRisk } from './command-safety/path-analysis.js';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';

test('ambiguous command families are YELLOW instead of RED', (t) => {
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
    t.is(classifyCommand(command), SafetyStatus.YELLOW, `"${command}" should let the model decide`);
  }
});

test('inherently dangerous direct commands remain RED', (t) => {
  const commands = ['rm -rf /', 'mkfs /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'sudo rm -rf /', 'shutdown now'];

  for (const command of commands) {
    t.is(classifyCommand(command), SafetyStatus.RED, `"${command}" should be hard-blocked`);
  }
});

test('read-only risky paths are YELLOW, not hard-blocked', (t) => {
  const paths = ['/etc/passwd', '/var/log/system.log', '../secrets.json'];

  for (const path of paths) {
    t.is(analyzePathRisk(path), SafetyStatus.YELLOW, `"${path}" should require model/user review`);
  }
});

test('workspace-scale edit commands are YELLOW instead of RED', (t) => {
  const commands = ['sed -i "s/foo/bar/" source.txt', 'find . -exec cp {} /tmp/backup \\;'];

  for (const command of commands) {
    t.is(classifyCommand(command), SafetyStatus.YELLOW, `"${command}" should let the model decide`);
  }
});
