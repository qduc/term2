import { it, expect } from 'vitest';
import { classifyCommand, SafetyStatus } from './command-safety/index.js';

it('specialized command handlers still inspect command substitutions', () => {
  const commands = [
    'git status $(rm -rf /)',
    'git show `rm -rf /`',
    'find . -name $(rm -rf /)',
    'sed -n $(rm -rf /) file.txt',
  ];

  for (const command of commands) {
    expect(classifyCommand(command), `"${command}" should inspect nested command substitution`).toBe(SafetyStatus.RED);
  }
});

it('specialized command handlers still inspect assignment command substitutions', () => {
  const commands = ['TARGET=$(rm -rf /) git status', 'PATTERN=$(rm -rf /) find . -name "*.ts"'];

  for (const command of commands) {
    expect(classifyCommand(command), `"${command}" should inspect command substitutions in prefixes`).toBe(
      SafetyStatus.RED,
    );
  }
});
