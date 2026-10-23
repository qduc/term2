# SSH Mode Implementation Plan

## Overview

Add `--ssh user@host` CLI flag to enable remote execution of shell commands and file operations over SSH using the `ssh2` library.

## CLI Flags

- `--ssh user@host` - Enable SSH mode with connection string
- `--remote-dir /path` - Required remote working directory
- `--ssh-port 22` - Optional SSH port (default: 22)
- Authentication via SSH agent only

## Architecture

### New Files

1. **`source/services/ssh-service.ts`** - SSH connection management

   - Uses `ssh2` library for SSH connections
   - Connection lifecycle (connect/disconnect)
   - Command execution via `client.exec()`
   - File operations via shell commands (cat/echo)

2. **`source/services/execution-context.ts`** - Execution context abstraction
   - `isRemote()` - Check if running in SSH mode
   - `getSSHService()` - Get SSH service instance
   - `getCwd()` - Get working directory (local or remote)

### Files to Modify

#### Phase 1: Core Infrastructure

| File                                    | Changes                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `package.json`                          | Add `ssh2` and `@types/ssh2` dependencies                                                        |
| `source/services/settings-service.ts`   | Add SSH settings schema (`ssh.enabled`, `ssh.host`, `ssh.port`, `ssh.username`, `ssh.remoteDir`) |
| `source/services/service-interfaces.ts` | Add `ISSHService` interface                                                                      |
| `source/cli.tsx`                        | Parse SSH flags, create SSH service, validate `--remote-dir` required                            |

#### Phase 2: Execution Layer

| File                            | Changes                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `source/utils/execute-shell.ts` | Add optional `sshService` to options, branch to SSH execution when provided |

#### Phase 3: Tool Updates

| File                             | Changes                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `source/tools/shell.ts`          | Accept `executionContext`, pass SSH service to `executeShellCommand` |
| `source/tools/read-file.ts`      | Convert to factory function, use SSH `cat` for remote reads          |
| `source/tools/apply-patch.ts`    | Add SSH execution path using heredoc writes                          |
| `source/tools/search-replace.ts` | Add SSH execution path                                               |
| `source/tools/utils.ts`          | Update `resolveWorkspacePath(path, baseDir?)` signature              |
| `source/tools/grep.ts`           | Convert to factory, pass execution context                           |
| `source/tools/find-files.ts`     | Convert to factory, pass execution context                           |

#### Phase 4: Integration

| File                           | Changes                                 |
| ------------------------------ | --------------------------------------- |
| `source/agent.ts`              | Create execution context, pass to tools |
| `source/components/Banner.tsx` | Show SSH connection status              |

## Key Implementation Details

### SSH Service

```typescript
interface ISSHService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  executeCommand(cmd: string, opts?): Promise<ShellExecutionResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}
```

### File Operations via Shell

- **Read**: `cat "/path/to/file"`
- **Write**: `cat > "/path" << 'TERM2_EOF'\n${content}\nTERM2_EOF`
- **Mkdir**: `mkdir -p "/path"`
- **Exists**: `test -f "/path" && echo "exists"`

### Execution Context Flow

```
CLI --ssh flag
    -> Create SSHService
    -> Create ExecutionContext(sshService, remoteDir)
    -> Pass to agent.ts
    -> Tools query context.isRemote()
    -> Branch to local or SSH execution
```

## Implementation Order

1. `npm install ssh2 @types/ssh2`
2. Create `ssh-service.ts` with tests
3. Create `execution-context.ts`
4. Update `settings-service.ts` schema
5. Update `cli.tsx` with flags and SSH init
6. Update `execute-shell.ts` for SSH path
7. Update `shell.ts` tool
8. Update `read-file.ts` tool (convert to factory)
9. Update `apply-patch.ts` tool
10. Update `search-replace.ts` tool
11. Update `grep.ts` and `find-files.ts`
12. Update `agent.ts` to wire everything
13. Update Banner for SSH status
14. Add cleanup handlers in `cli.tsx`

## Testing

- Unit tests for SSHService with mocked ssh2
- Unit tests for ExecutionContext
- Manual testing with actual SSH server
