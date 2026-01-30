import test from 'ava';
import {
    classifyCommand,
    SafetyStatus,
    validateCommandSafety,
} from './command-safety/index.js';

// ============================================================================
// GREEN: Safe read-only find commands
// ============================================================================

test('find - basic name search (GREEN)', t => {
    const commands = [
        'find . -name "*.txt"',
        'find . -iname "*.TXT"',
        'find . -name "test.js"',
        'find ./src -name "*.ts"',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.GREEN, `"${cmd}" should be GREEN`);
    }
});

test('find - type filters (GREEN)', t => {
    const commands = [
        'find . -type f',
        'find . -type d',
        'find . -type l',
        'find ./src -type f -name "*.js"',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.GREEN, `"${cmd}" should be GREEN`);
    }
});

test('find - size and depth filters (GREEN)', t => {
    const commands = [
        'find . -size +1M',
        'find . -maxdepth 3',
        'find . -mindepth 1',
        'find . -maxdepth 2 -name "*.js"',
        'find . -empty',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.GREEN, `"${cmd}" should be GREEN`);
    }
});

test('find - safe print operations (GREEN)', t => {
    const commands = [
        'find . -print',
        'find . -print0',
        'find . -printf "%f\\n"',
        'find . -ls',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.GREEN, `"${cmd}" should be GREEN`);
    }
});

test('find - path patterns (GREEN)', t => {
    const commands = [
        'find . -path "*/test/*"',
        "find . -regex '.*\\.py$'", // Use single quotes to avoid $ expansion issues
        'find ./src -name "*.tsx"',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.GREEN, `"${cmd}" should be GREEN`);
    }
});

// ============================================================================
// YELLOW: Suspicious but not forbidden
// ============================================================================

test('find - symlink following flags (YELLOW)', t => {
    const commands = [
        'find -L . -name "*.txt"',
        'find -follow . -name "*.txt"',
        'find -H . -name "*.txt"',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

test('find - file output flags (YELLOW)', t => {
    const commands = [
        'find . -fprint /tmp/output.txt',
        'find . -fprint0 /tmp/output.txt',
        'find . -fprintf /tmp/output.txt "%p\\n"',
        'find . -fls /tmp/output.txt',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

test('find - SUID/SGID permission searches (YELLOW)', t => {
    const commands = [
        'find / -perm -4000',
        'find / -perm -2000',
        'find / -perm /6000',
        'find . -perm -u+s',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

test('find - absolute system paths (YELLOW)', t => {
    const commands = [
        'find /etc -name "*.conf"',
        'find /var/log -name "*.log"',
        'find /home -name "*.txt"',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

test('find - read-only exec commands (YELLOW)', t => {
    const commands = [
        'find . -exec cat {} \\;',
        'find . -exec head {} \\;',
        'find . -exec grep pattern {} \\;',
        'find . -exec wc -l {} \\;',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

// ============================================================================
// RED: Dangerous operations
// ============================================================================

test('find - delete flag (RED)', t => {
    const commands = [
        'find . -name "*.tmp" -delete',
        'find . -type f -delete',
        'find ./temp -delete',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - exec with destructive commands (RED)', t => {
    const commands = [
        'find . -exec rm {} \\;',
        'find . -exec rm -rf {} \\;',
        'find . -exec shred {} \\;',
        'find . -exec chmod 777 {} \\;',
        'find . -exec chown root {} \\;',
        'find . -exec mv {} /tmp \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - exec with shell commands (RED)', t => {
    const commands = [
        'find . -exec sh -c "rm $0" {} \\;',
        'find . -exec bash -c "echo test" {} \\;',
        'find . -exec /bin/sh -c "dangerous" {} \\;',
        'find . -exec zsh -c "test" {} \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - exec with shell metacharacters (RED)', t => {
    const commands = [
        'find . -exec echo {} | cat \\;',
        'find . -exec cat {} > /tmp/out \\;',
        'find . -exec echo $PATH \\;',
        'find . -exec test `whoami` \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - malformed exec (no terminator) (RED)', t => {
    const commands = ['find . -exec rm {}', 'find . -exec cat'];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED error for malformed exec`,
        );
    }
});

test('find - execdir variants (RED)', t => {
    const commands = [
        'find . -execdir rm {} \\;',
        'find . -execdir bash -c "test" {} \\;',
        'find . -ok rm {} \\;',
        'find . -okdir chmod 777 {} \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

// ============================================================================
// Edge Cases
// ============================================================================

test('find - multiple exec flags (RED if any dangerous)', t => {
    // First safe, second dangerous
    t.true(
        validateCommandSafety('find . -exec echo {} \\; -exec rm {} \\;'),
        'Should return true if any exec is dangerous',
    );
});

test('find - exec with plus terminator (RED if dangerous)', t => {
    const commands = ['find . -exec rm {} +', 'find . -exec rm {} \\+'];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - exec with plus terminator (YELLOW if safe)', t => {
    const commands = ['find . -exec cat {} +', 'find . -exec wc -l {} +'];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(result, SafetyStatus.YELLOW, `"${cmd}" should be YELLOW`);
    }
});

test('find - false positives to avoid', t => {
    // These contain "exec" or "delete" but are not the dangerous flags
    const commands = [
        'find . -name "*exec*"',
        'find . -name "*delete*"',
        'find . -path "*/delete-me/*"',
        'find ./exec-files -type f',
    ];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(
            result,
            SafetyStatus.GREEN,
            `"${cmd}" should be GREEN (false positive avoidance)`,
        );
    }
});

test('find - escaped semicolons (RED if dangerous)', t => {
    const commands = [
        'find . -exec rm {} ";"',
        "find . -exec rm {} ';'",
        'find . -exec rm {} \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - directory traversal in paths (RED)', t => {
    const commands = [
        'find ../../../etc -name "*.conf"',
        'find ../../.ssh -type f',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - home directory searches (RED)', t => {
    const commands = [
        'find ~ -name "*.txt"',
        'find ~/.ssh -type f',
        'find $HOME/.env',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - empty exec command (RED)', t => {
    t.true(
        validateCommandSafety('find . -exec \\;'),
        'Empty exec command should return true',
    );
});

test('find - boolean operators maintain safety classification', t => {
    // Safe OR safe = GREEN
    const safe = classifyCommand('find . -name "*.txt" -o -name "*.md"');
    t.is(safe, SafetyStatus.GREEN);

    // Safe AND dangerous = RED
    t.true(validateCommandSafety('find . -name "*.txt" -delete'));

    // NOT operation doesn't change classification
    const notSafe = classifyCommand('find . ! -name "*.txt"');
    t.is(notSafe, SafetyStatus.GREEN);
});

// ============================================================================
// Security Review Findings - Critical Bypasses
// ============================================================================

test('find - interpreter bypasses (RED)', t => {
    const commands = [
        'find . -exec perl -e "unlink" {} \\;',
        'find . -exec python -c "import os; os.system(\\"rm *\\")" {} \\;',
        'find . -exec ruby -e "`rm *`" {} \\;',
        'find . -exec node -e "require(\\"child_process\\").execSync(\\"rm *\\")" {} \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - meta-executor bypasses (RED)', t => {
    const commands = [
        'find . -exec env rm {} \\;',
        'find . -exec xargs rm \\;',
        'find . -exec nohup rm {} \\;',
        'find . -exec timeout 10 rm {} \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - more destructive commands (RED)', t => {
    const commands = [
        'find . -exec truncate -s 0 {} \\;',
        'find . -exec tee /dev/null {} \\;',
        'find . -exec cp {} /tmp/backup \\;',
        'find . -exec ln -s {} /tmp/link \\;',
        'find . -exec rsync -a {} /backup \\;',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - executing found files directly (RED)', t => {
    t.true(
        validateCommandSafety('find / -perm -4000 -exec {} \\;'),
        'Executing found SUID binaries should return true for RED command',
    );
});

test('find - inode-based bypass (YELLOW)', t => {
    const result = classifyCommand('find / -inum 12345');
    t.is(result, SafetyStatus.YELLOW, '-inum flag should be YELLOW');
});

test('find - root traversal for DoS (YELLOW)', t => {
    const commands = ['find / -name "*"', 'find // -type f'];

    for (const cmd of commands) {
        const result = classifyCommand(cmd);
        t.is(
            result,
            SafetyStatus.YELLOW,
            `"${cmd}" should be YELLOW (DoS risk)`,
        );
    }
});

test('find - expanded home directory patterns (RED)', t => {
    const commands = [
        'find /home/user -name "*"',
        'find /Users/alice -name "*"',
        'find /root -type f',
        'find $USER -name "*.txt"',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});

test('find - sensitive dotfiles expanded list (RED)', t => {
    const commands = [
        'find ~/.aws -type f',
        'find ~/.kube/config',
        'find ~/.gnupg -name "*"',
        'find ~/.bash_history',
    ];

    for (const cmd of commands) {
        t.true(
            validateCommandSafety(cmd),
            `"${cmd}" should return true for RED command`,
        );
    }
});
