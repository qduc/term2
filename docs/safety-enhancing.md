This is a technical plan to migrate your validation logic from Regex (pattern matching) to Abstract Syntax Tree (AST) parsing using `bash-parser`.

This approach treats the command string like code, allowing us to distinguish between `rm` the command (dangerous) and `firmware.rm` the filename (safe).

### Prerequisites

You will need to install the parser:

```bash
npm install bash-parser
# OR
yarn add bash-parser
```

---

### Step 1: Define the "Deny List"

Instead of complex regex patterns, we will create a clean `Set` of command names. This is faster (O(1) lookup) and easier to maintain.

```typescript
// The set of binary names strictly forbidden from automatic execution
const BLOCKED_COMMANDS = new Set([
    // Filesystem
    'rm',
    'rmdir',
    'mkfs',
    'dd',
    'mv',
    'cp',
    // System
    'sudo',
    'su',
    'chmod',
    'chown',
    'shutdown',
    'reboot',
    // Network/Web
    'curl',
    'wget',
    'ssh',
    'scp',
    'netstat',
    // Package Managers (often modify global state)
    'apt',
    'yum',
    'npm',
    'pip',
    'gem',
    // Dangerous wrappers
    'eval',
    'exec',
    'watch',
]);
```

### Step 2: The Recursive AST Walker

The parser turns a command string into a deep tree of objects. A simple loop won't work because commands can be nested inside other commands (e.g., `echo $(rm secret.txt)`).

We need a recursive function that looks for specific Node Types:

1.  **`Command`**: The basic unit (e.g., `ls`). We check the `.name.text` property.
2.  **`LogicalExpression`**: Chains like `&&` or `||`. We must check both Left and Right sides.
3.  **`Pipeline`**: Pipes like `|`. We must check all parts of the pipe.
4.  **`Subshell`**: Commands inside `( ... )`.
5.  **`CommandSubstitution`**: Commands inside `$( ... )` or backticks.

### Step 3: Implementation Code

Here is the robust, AST-based replacement for your `isDangerousCommand` function.

```typescript
import parse from 'bash-parser';

const BLOCKED_COMMANDS = new Set([
    'rm',
    'rmdir',
    'mkfs',
    'dd',
    'mv',
    'cp',
    'sudo',
    'su',
    'chmod',
    'chown',
    'shutdown',
    'reboot',
    'curl',
    'wget',
    'ssh',
    'scp',
    'netstat',
    'apt',
    'yum',
    'npm',
    'yarn',
    'pnpm',
    'pip',
    'gem',
    'eval',
    'exec',
    'kill',
    'killall',
]);

/**
 * Recursively inspects a node from the AST to find dangerous commands.
 */
function containsDangerousCommand(node: any): boolean {
    if (!node) return false;

    // CASE 1: It's a direct command (e.g., "rm -rf /")
    if (node.type === 'Command') {
        // node.name can be undefined if it's a variable assignment like "x=1"
        if (node.name && node.name.text) {
            if (BLOCKED_COMMANDS.has(node.name.text)) {
                return true;
            }
        }

        // CRITICAL: Check for subshells in arguments (e.g., "echo $(rm -rf /)")
        // Arguments are in node.suffix
        if (node.suffix) {
            for (const arg of node.suffix) {
                if (containsDangerousCommand(arg)) return true;
            }
        }
        return false;
    }

    // CASE 2: Logical Operators (e.g., "git pull && npm install")
    if (node.type === 'LogicalExpression') {
        return (
            containsDangerousCommand(node.left) ||
            containsDangerousCommand(node.right)
        );
    }

    // CASE 3: Pipelines (e.g., "cat file | grep secret")
    if (node.type === 'Pipeline') {
        return node.commands.some((cmd: any) => containsDangerousCommand(cmd));
    }

    // CASE 4: Subshells (e.g., "(rm -rf /)")
    if (node.type === 'Subshell') {
        return node.list.some((cmd: any) => containsDangerousCommand(cmd));
    }

    // CASE 5: Command Substitution (e.g., `$( ... )` or backticks)
    if (node.type === 'CommandSubstitution') {
        return node.commands.some((cmd: any) => containsDangerousCommand(cmd));
    }

    return false;
}

export function validateCommandSafety(commandString: string): boolean {
    try {
        if (!commandString || !commandString.trim()) return false;

        // 1. Parse string into AST
        // { mode: 'bash' } allows standard bash syntax parsing
        const ast = parse(commandString, {mode: 'bash'});

        // 2. The AST is a list of commands (Script). Iterate them.
        if (ast.commands) {
            return ast.commands.some((node: any) =>
                containsDangerousCommand(node),
            );
        }

        return false;
    } catch (error) {
        // If the parser fails (invalid syntax), standard safety policy:
        // FAIL CLOSED (assume dangerous if we can't understand it).
        console.warn(
            'Command parsing failed, requiring manual approval:',
            error,
        );
        return true;
    }
}
```
