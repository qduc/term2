import { it, expect } from 'vitest';
import { classifyCommand, SafetyStatus, validateCommandSafety } from './command-safety/index.js';

// ============================================================================
// GREEN: Safe read-only find commands
// ============================================================================

it('find - basic name search (GREEN)', () => {
  const commands = [
    'find . -name "*.txt"',
    'find . -iname "*.TXT"',
    'find . -name "test.js"',
    'find ./src -name "*.ts"',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('find - type filters (GREEN)', () => {
  const commands = ['find . -type f', 'find . -type d', 'find . -type l', 'find ./src -type f -name "*.js"'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('find - size and depth filters (GREEN)', () => {
  const commands = [
    'find . -size +1M',
    'find . -maxdepth 3',
    'find . -mindepth 1',
    'find . -maxdepth 2 -name "*.js"',
    'find . -empty',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('find - safe print operations (GREEN)', () => {
  const commands = ['find . -print', 'find . -print0', 'find . -printf "%f\\n"', 'find . -ls'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

it('find - path patterns (GREEN)', () => {
  const commands = [
    'find . -path "*/test/*"',
    "find . -regex '.*\\.py$'", // Use single quotes to avoid $ expansion issues
    'find ./src -name "*.tsx"',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN`).toBe(SafetyStatus.GREEN);
  }
});

// ============================================================================
// YELLOW: Suspicious but not forbidden
// ============================================================================

it('find - symlink following flags (YELLOW)', () => {
  const commands = ['find -L . -name "*.txt"', 'find -follow . -name "*.txt"', 'find -H . -name "*.txt"'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - file output flags (YELLOW)', () => {
  const commands = [
    'find . -fprint /tmp/output.txt',
    'find . -fprint0 /tmp/output.txt',
    'find . -fprintf /tmp/output.txt "%p\\n"',
    'find . -fls /tmp/output.txt',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - SUID/SGID permission searches (YELLOW)', () => {
  const commands = ['find / -perm -4000', 'find / -perm -2000', 'find / -perm /6000', 'find . -perm -u+s'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - absolute system paths (YELLOW)', () => {
  const commands = ['find /etc -name "*.conf"', 'find /var/log -name "*.log"', 'find /home -name "*.txt"'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - read-only exec commands (YELLOW)', () => {
  const commands = [
    'find . -exec cat {} \\;',
    'find . -exec head {} \\;',
    'find . -exec grep pattern {} \\;',
    'find . -exec wc -l {} \\;',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

// ============================================================================
// RED: Dangerous operations
// ============================================================================

it('find - delete flag (RED)', () => {
  const commands = ['find . -name "*.tmp" -delete', 'find . -type f -delete', 'find ./temp -delete'];

  for (const cmd of commands) {
    expect(validateCommandSafety(cmd)).toBe(true);
  }
});

it('find - exec with inherently destructive commands (RED)', () => {
  const commands = ['find . -exec rm {} \\;', 'find . -exec rm -rf {} \\;', 'find . -exec shred {} \\;'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be RED`).toBe(SafetyStatus.RED);
  }
});

it('find - exec with ambiguous write commands (YELLOW)', () => {
  const commands = [
    'find . -exec chmod 777 {} \\;',
    'find . -exec chown root {} \\;',
    'find . -exec mv {} /tmp \\;',
    'find . -exec cp {} /tmp/backup \\;',
    'find . -exec ln -s {} /tmp/link \\;',
    'find . -exec rsync -a {} /backup \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - exec with shell commands (YELLOW)', () => {
  const commands = [
    'find . -exec sh -c "rm $0" {} \\;',
    'find . -exec bash -c "echo test" {} \\;',
    'find . -exec /bin/sh -c "dangerous" {} \\;',
    'find . -exec zsh -c "test" {} \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - exec with shell metacharacters (YELLOW)', () => {
  const commands = [
    'find . -exec echo {} | cat \\;',
    'find . -exec cat {} > /tmp/out \\;',
    'find . -exec echo $PATH \\;',
    'find . -exec test `whoami` \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - malformed exec without terminator (YELLOW)', () => {
  const commands = ['find . -exec rm {}', 'find . -exec cat'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - execdir variants follow command severity', () => {
  const redCommands = ['find . -execdir rm {} \\;', 'find . -ok rm {} \\;'];
  const yellowCommands = ['find . -execdir bash -c "test" {} \\;', 'find . -okdir chmod 777 {} \\;'];

  for (const cmd of redCommands) {
    expect(classifyCommand(cmd), `"${cmd}" should be RED`).toBe(SafetyStatus.RED);
  }

  for (const cmd of yellowCommands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

// ============================================================================
// Edge Cases
// ============================================================================

it('find - multiple exec flags (RED if any dangerous)', () => {
  // First safe, second dangerous
  expect(validateCommandSafety('find . -exec echo {} \\; -exec rm {} \\;')).toBe(true);
});

it('find - exec with plus terminator (RED if dangerous)', () => {
  const commands = ['find . -exec rm {} +', 'find . -exec rm {} \\+'];

  for (const cmd of commands) {
    expect(validateCommandSafety(cmd)).toBe(true);
  }
});

it('find - exec with plus terminator (YELLOW if safe)', () => {
  const commands = ['find . -exec cat {} +', 'find . -exec wc -l {} +'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - false positives to avoid', () => {
  // These contain "exec" or "delete" but are not the dangerous flags
  const commands = [
    'find . -name "*exec*"',
    'find . -name "*delete*"',
    'find . -path "*/delete-me/*"',
    'find ./exec-files -type f',
  ];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result, `"${cmd}" should be GREEN (false positive avoidance)`).toBe(SafetyStatus.GREEN);
  }
});

it('find - escaped semicolons (RED if inherently destructive)', () => {
  const commands = ['find . -exec rm {} ";"', "find . -exec rm {} ';'", 'find . -exec rm {} \\;'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be RED`).toBe(SafetyStatus.RED);
  }
});

it('find - directory traversal in paths (YELLOW)', () => {
  const commands = ['find ../../../etc -name "*.conf"', 'find ../../.ssh -type f'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - broad home directory searches (YELLOW)', () => {
  const commands = ['find ~ -name "*.txt"', 'find $HOME -name "*.txt"', 'find /Users/alice -name "*.txt"'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd), `"${cmd}" should be YELLOW`).toBe(SafetyStatus.YELLOW);
  }
});

it('find - empty exec command (YELLOW)', () => {
  expect(classifyCommand('find . -exec \\;'), 'Empty exec command should be YELLOW').toBe(SafetyStatus.YELLOW);
});

it('find - boolean operators maintain safety classification', () => {
  // Safe OR safe = GREEN
  const safe = classifyCommand('find . -name "*.txt" -o -name "*.md"');
  expect(safe).toBe(SafetyStatus.GREEN);

  // Safe AND dangerous = RED
  expect(validateCommandSafety('find . -name "*.txt" -delete')).toBe(true);

  // NOT operation doesn't change classification
  const notSafe = classifyCommand('find . ! -name "*.txt"');
  expect(notSafe).toBe(SafetyStatus.GREEN);
});

// ============================================================================
// Security Review Findings - Critical Bypasses
// ============================================================================

it('find - interpreter bypasses (YELLOW)', () => {
  const commands = [
    'find . -exec perl -e "unlink" {} \\;',
    'find . -exec python -c "import os; os.system(\\"rm *\\")" {} \\;',
    'find . -exec ruby -e "system(\\"rm *\\")" {} \\;',
    'find . -exec node -e "require(\\"child_process\\").execSync(\\"rm *\\")" {} \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd)).toBe(SafetyStatus.YELLOW);
  }
});

it('find - meta-executor bypasses (YELLOW)', () => {
  const commands = [
    'find . -exec env rm {} \\;',
    'find . -exec xargs rm \\;',
    'find . -exec nohup rm {} \\;',
    'find . -exec timeout 10 rm {} \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd)).toBe(SafetyStatus.YELLOW);
  }
});

it('find - more inherently destructive commands (RED)', () => {
  const commands = ['find . -exec truncate -s 0 {} \\;'];

  for (const cmd of commands) {
    expect(classifyCommand(cmd)).toBe(SafetyStatus.RED);
  }
});

it('find - more ambiguous write commands (YELLOW)', () => {
  const commands = [
    'find . -exec tee /dev/null {} \\;',
    'find . -exec cp {} /tmp/backup \\;',
    'find . -exec ln -s {} /tmp/link \\;',
    'find . -exec rsync -a {} /backup \\;',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd)).toBe(SafetyStatus.YELLOW);
  }
});

it('find - executing found files directly (RED)', () => {
  expect(validateCommandSafety('find / -perm -4000 -exec {} \\;')).toBe(true);
});

it('find - inode-based bypass (YELLOW)', () => {
  const result = classifyCommand('find / -inum 12345');
  expect(result).toBe(SafetyStatus.YELLOW);
});

it('find - root traversal for DoS (YELLOW)', () => {
  const commands = ['find / -name "*"', 'find // -type f'];

  for (const cmd of commands) {
    const result = classifyCommand(cmd);
    expect(result).toBe(SafetyStatus.YELLOW);
  }
});

it('find - expanded home directory patterns (YELLOW)', () => {
  const commands = [
    'find /home/user -name "*"',
    'find /Users/alice -name "*"',
    'find /root -type f',
    'find $USER -name "*.txt"',
  ];

  for (const cmd of commands) {
    expect(classifyCommand(cmd)).toBe(SafetyStatus.YELLOW);
  }
});

it('find - sensitive dotfiles expanded list (RED)', () => {
  const commands = [
    'find ~/.ssh -type f',
    'find $HOME/.env',
    'find ~/.aws -type f',
    'find ~/.kube/config',
    'find ~/.gnupg -name "*"',
    'find ~/.bash_history',
  ];

  for (const cmd of commands) {
    expect(validateCommandSafety(cmd)).toBe(true);
  }
});
