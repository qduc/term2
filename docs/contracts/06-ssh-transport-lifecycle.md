# Contract 06 — SSH transport lifecycle

Status: **repair implemented and verified 2026-08-16.** The retained
expected-failure characterizations (in-flight transport drop settlement,
POSIX single-quote escaping, `isConnected` after client `close`) are now
passing tests; the opt-in `timeoutMs`/`AbortSignal` options and the
once-per-client lifecycle are implemented through the public boundary. See
§10 for the repair record.

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C6.1 | `isConnected()` truthfully reflects transport connection state across connect, idle disconnect, server end, and socket close. | Operations are dispatched against dead transports, or stale connection state prevents clean reconnects. |
| C6.2 | In remote mode, `ExecutionContext` treats `remoteDir` as authoritative root and rejects local workspace leases (`enterWorkspace`). | Commands execute against unexpected local workspaces, leaking host data or clobbering local repositories during remote sessions. |
| C6.3 | Every in-flight `executeCommand` promise settles (rejects with a typed transport outcome) on connection error, socket drop, client close, channel error, explicit disconnect, abort, or elapsed `timeoutMs`; it must never hang indefinitely. | Deadlocked agent run loop: when remote network drops, the turn hangs indefinitely without surfacing an error or allowing user retry. |
| C6.4 | Remote working directories (`cwd`) and file operation paths (`readFile`, `writeFile`, `mkdir`, editor `rm`) are treated strictly as data and encoded using canonical POSIX single-quote escaping (`'${v.replace(/'/g, "'\\''")}'`). | Remote command injection: untrusted directory or file paths containing quotes, whitespace, `$VAR`, subshells `$(...)`, or shell operators break out and execute arbitrary commands on the remote machine. |
| C6.5 | Remote command execution delivers structured exit codes and stream outputs faithfully, while file helper operations throw descriptive errors on non-zero exit codes. | Tools cannot distinguish normal command failure from transport failure; file read/write errors are silently ignored. |

## 2. Owners

- **Enforcement:**
  - `SSHService` (`source/services/ssh-service.ts`) — owns transport connection lifecycle, ssh2 client events, stream listeners, heredoc construction, and remote command invocation, including typed in-flight settlement.
  - `ExecutionContext` (`source/services/execution-context.ts`) — owns remote vs local execution mode authority, working directory resolution, and workspace lease validation.
- **Recovery:**
  - `SSHService.disconnect` — idempotently settles active commands with `explicit_disconnect`, calls `client.end()`, and marks `connected = false`.
  - `SSHService.connect` — single-flight; a call while connected resolves without reconnecting and attaches no duplicate listeners.
  - `ExecutionContext.exitWorkspace` — restores home root when leaving workspace leases.

## 3. Execution paths that share the contract

- **CLI Bootstrap & Teardown:** `source/cli.tsx:511-536` (`service.connect()`, `executeCommand('pwd')` to detect remote working directory, and `service.disconnect()` during shutdown).
- **Execution Context Mode Authority:** `source/services/execution-context.ts:20-30` (holds `ISSHService`, sets `isRemote() === true`, and locks working directory authority to `remoteDir`).
- **Remote Shell Bridge:** `source/utils/shell/execute-shell.ts:342-344` (`executeShellCommand` forwarding execution to `sshService.executeCommand` when present). Forwards `cwd` only; the global shell `timeout`/`signal` policy is deliberately **not** forwarded (see §10, audit).
- **System Tool (shell):** `source/tools/system/shell.ts:734-738`, `:804-809`, and `:1008` (bypasses local sandbox, rejects background shell jobs for SSH, and routes execution through `executeShellCommandImpl` with `sshService`).
- **Interactive Shell Session:** `source/services/shell/shell-interaction-session.ts:102-125` (interactive lite shell execution over remote SSH).
- **Editor Implementation:** `source/lib/editor-impl.ts:88, 97, 152, 191` (`createFile` calling `mkdir` and `writeFile`; `updateFile` calling `readFile` and `writeFile`); `:248` `deleteFile` now executes `rm -f ${quoteShellArg(targetPath)}` — the target path is POSIX single-quote escaped through the shared helper, closing the sibling injection vector listed in §10 Defect Class 2.
- **File Tool (create_file):** `source/tools/file/create-file.ts:85, 181-182, 205-206` (`fileExists` calling `readFile`; `execute` calling `mkdir` and `writeFile`).
- **File Tool (read_file):** `source/tools/file/read-file.ts:148` (calls `readFile(absolutePath)`).
- **File Tool (search_replace):** `source/tools/file/search-replace.ts:398, 403` (calls `readFile` and `writeFile`).
- **File Tool (apply_patch):** `source/tools/file/apply-patch.ts:282, 362, 367, 372` (calls `readFile`, `writeFile`, and `mkdir`).
- **File Tool (glob):** `source/tools/file/glob.ts:52, 175-216` (`checkFdAvailability` calling `executeCommand('fd --version')`; `findFiles` delegating via `executeShellCommand` with single-quote escaping).
- **File Tool (grep):** `source/tools/file/grep.ts:63, 129, 236-290` (`checkRgAvailability` calling `executeCommand('rg --version')`; `runGrep` delegating via `executeShellCommand` with `shellQuoteArg`).

## 4. Identities and state crossing the boundary

- `SSHConfig`: `{ host: string; port: number; username: string; agent?: string; identityFile?: string }` crossing at `SSHService` construction.
- `executeCommand` Options (`SSHCommandOptions`): `{ cwd?: string; timeoutMs?: number; signal?: AbortSignal }`. Absent options preserve pre-repair behavior exactly: no timeout timer, no abort listener, `cwd` optional.
- `executeCommand` Result (`SSHCommandResult`): `{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }` — resolved results keep full fidelity.
- Typed settlement (`SSHTransportError`, exported from `source/services/ssh-service.ts`): `{ name: 'SSHTransportError'; kind: SSHTransportErrorKind; remoteEffect: 'none' | 'unknown'; cause?: unknown; partialOutput?: { stdout: string; stderr: string } }`.
- Connection State: private `connected: boolean` projected through public `isConnected(): boolean`.
- Stream Events: ssh2 `ready`, `error`, `end`, `close`, `data` (stdout/stderr).
- Listener policy: connection-lifecycle listeners attach **once per client instance**; `connect()` is single-flight; per-command listeners are removed on settlement. Keepalive policy is explicitly **none** — no keepalive configuration and no background pings.

## 5. Settlement semantics

Aligned with Contract 05 and tool-output effect safety. Every rejection is a
typed `SSHTransportError`; `remoteEffect` is the truthful classification.

| Settlement trigger | Kind | remoteEffect | Provenance |
| --- | --- | --- | --- |
| `executeCommand` when `isConnected() === false` | `not_connected` | `none` | Pre-dispatch; no packet sent. |
| Signal already aborted before dispatch | `aborted` | `none` | Pre-dispatch; no command string handed to the transport. |
| `client.exec` callback error | `exec_failed` | `unknown` | Dispatch may or may not have reached the wire. |
| Client `'error'` while in flight | `connection_error` | `unknown` | Remote process may have run. |
| Client `'end'` while in flight | `connection_end` | `unknown` | Remote process may have run. |
| Client `'close'` while in flight | `connection_close` | `unknown` | Remote process may have run. |
| Stream `'error'` while in flight | `channel_error` | `unknown` | Remote process may have run. |
| `disconnect()` while in flight | `explicit_disconnect` | `unknown` | Remote process may have run. |
| `AbortSignal` abort while in flight | `aborted` | `unknown` | Remote process may have run. |
| `timeoutMs` elapsed without stream close | `timeout` | `unknown` | Remote process may still be running; not killed, not replayed. |

**Remote-effect ambiguity is preserved, never papered over.** A transport-level
settlement with `remoteEffect: 'unknown'` means the remote command may have
completed, partially completed, or be orphaned; blind replay of a
non-idempotent command is unsafe and the typed outcome does not claim
otherwise. `partialOutput` carries best-effort bytes received before
settlement and is explicitly not a complete result.

**Normal settlement is unchanged:** stream `'close' (exitCode)` resolves
`{ stdout, stderr, exitCode, timedOut: false }`. `timedOut` remains `false`
in resolved results because timeouts are typed rejections, not resolutions.

**File helper settlement is unchanged:** `readFile`, `writeFile`, `mkdir`
resolve on `exitCode === 0`; reject with descriptive error containing remote
`stderr` on `exitCode !== 0`.

## 6. Observability

- **Current Behavior:**
  - `SSHService.connect`: Throws raw connection errors; does not log structured events or attach target host telemetry.
  - `SSHService.executeCommand`: Buffers raw stdout and stderr strings in memory; does not emit streaming chunk telemetry or log command durations.
  - `SSHService.writeFile`: Validates that content does not contain the unique heredoc delimiter token (`TERM2_EOF_<timestamp>`), throwing a safety error if collision occurs.
- **Diagnostics Gaps (unchanged):**
  - Zero structured logging for SSH connection state transitions (`connecting`, `ready`, `closed`, `error`).
  - `executeShellCommand` ignores `onOutputChunk` when routing to `sshService` (`execute-shell.ts:342-344`), preventing live streaming output in the terminal UI during remote command execution.

## 7. Public boundary under test

The contract is tested deterministically at the public interface boundary of:
- `ISSHService` / `SSHService` (`source/services/ssh-service.ts`)
- `ExecutionContext` (`source/services/execution-context.ts`)

No internal private fields are accessed; all tests use public operations and simulated transport event injection on the injected ssh2 `Client`. Time-bound behavior uses `vi.useFakeTimers()` with manually driven mock callbacks — no real waits.

## 8. Deterministic contract matrix

All rows are green as of 2026-08-16 in `source/services/ssh-service.test.ts`.

| Seam / Scenario | Invariant | Expected Outcome | Classification | Exact Test Declaration & Location |
|---|---|---|---|---|
| Connect establishes connection | C6.1 | `isConnected() === true`, resolves | Verified | `:82` `it('connect: establishes connection successfully')` |
| Connect failure on error | C6.1 | `isConnected() === false`, rejects | Verified | `:92` `it('connect: rejects on connection error')` |
| Repeated connect while connected | C6.1 | Resolves without reconnecting; one `client.connect` call | Verified (repair) | `:106` `it('connect: repeated connect while connected resolves without reconnecting')` |
| Disconnect closes connection | C6.1 | `client.end()` called, `isConnected() === false` | Verified | `:118` `it('disconnect: closes connection')` |
| Disconnect when already closed | C6.1 | No-op, `isConnected() === false` | Verified | `:130` `it('disconnect: handles already disconnected')` |
| Initial state unconnected | C6.1 | `isConnected() === false` | Verified | `:140` `it('isConnected: returns false initially')` |
| Server end marks disconnected | C6.1 | `isConnected() === false` after `'end'` | Verified | `:147` `it('isConnected: returns false after end event')` |
| Server close marks disconnected | C6.1 | `isConnected() === false` after `'close'` | **Repaired (was retained expected failure)** | `:159` `it('isConnected: returns false after client close event')` |
| Execute when disconnected | C6.1 | Typed `not_connected`, `remoteEffect: 'none'`, no dispatch | Verified | `:173` + `:180` (`it('executeCommand: rejects with a typed not_connected outcome before any dispatch')`) |
| Execute command success (Exit 0) | C6.5 | Resolves stdout, stderr, exitCode 0, `timedOut: false` | Verified | `:192` `it('executeCommand: executes command and returns result')` |
| Execute command non-zero exit | C6.5 | Resolves stderr, exitCode 127 | Verified | `:214` `it('executeCommand: captures stderr')` |
| Execute mixed stdout and stderr | C6.5 | Resolves interleaved buffers | Verified | `:231` `it('executeCommand: handles both stdout and stderr')` |
| Execute with cwd option | C6.5 | Prepends `cd '<cwd>' &&` (single-quoted) | Verified | `:250` `it('executeCommand: prepends cd when cwd option provided')` |
| Execute exec dispatch failure | C6.5 | Typed `exec_failed`, `remoteEffect: 'unknown'` | Verified | `:265` + `:278` (`it('executeCommand: rejects with a typed exec_failed outcome on dispatch failure')`) |
| Read file success | C6.5 | Returns file stdout via `cat` | Verified | `:296` `it('readFile: reads file content via cat')` |
| Read file failure | C6.5 | Throws error containing stderr | Verified | `:313` `it('readFile: throws on failure')` |
| Write file heredoc | C6.5 | Writes via quoted heredoc | Verified | `:327` `it('writeFile: writes content via heredoc')` |
| Write file failure | C6.5 | Throws error containing stderr | Verified | `:345` `it('writeFile: throws on failure')` |
| Write file delimiter collision | C6.5 | Throws delimiter collision error | Verified | `:359` `it('writeFile: throws if content contains delimiter')` |
| Mkdir directory | C6.5 | Executes `mkdir '<path>'` | Verified | `:378` `it('mkdir: creates directory')` |
| Mkdir recursive | C6.5 | Executes `mkdir -p '<path>'` | Verified | `:394` `it('mkdir: creates directory recursively')` |
| Mkdir failure | C6.5 | Throws error containing stderr | Verified | `:410` `it('mkdir: throws on failure')` |
| Execution context remote mode | C6.2 | Reports `isRemote() === true`, cwd = remoteDir | Verified | `source/services/execution-context.test.ts:30`, `:52` |
| Remote mode rejects local lease | C6.2 | Throws error rejecting `enterWorkspace` | Verified | `source/services/execution-context.test.ts:104` |
| In-flight drop: connection error | C6.3 | Typed `connection_error`, `remoteEffect: 'unknown'` | **Repaired (was retained expected failure)** | `:430` `it('executeCommand: in-flight connection error rejects the pending command rather than hanging indefinitely')` |
| In-flight drop: server end | C6.3 | Typed `connection_end` | **Repaired (was retained expected failure)** | `:460` `it('executeCommand: in-flight connection end rejects the pending command rather than hanging indefinitely')` |
| In-flight drop: client close | C6.3 | Typed `connection_close` | **Repaired (was retained expected failure)** | `:488` `it('executeCommand: in-flight client close rejects the pending command rather than hanging indefinitely')` |
| In-flight drop: stream channel | C6.3 | Typed `channel_error` | **Repaired (was retained expected failure)** | `:516` `it('executeCommand: in-flight stream channel error rejects the pending command rather than hanging indefinitely')` |
| In-flight drop: disconnect() | C6.3 | Typed `explicit_disconnect` | **Repaired (was retained expected failure)** | `:544` `it('executeCommand: explicit disconnect while command is in flight rejects the pending command')` |
| Drop settles all active commands | C6.3 | Two concurrent commands both settle on one drop | Verified (repair) | `:572` `it('executeCommand: a transport drop settles every command active at that moment')` |
| Partial output on drop | C6.3 | `partialOutput` carries bytes; not a complete result | Verified (repair) | `:587` `it('executeCommand: preserves partial output on a transport drop without claiming completeness')` |
| Reconnect era isolation | C6.3 / C6.1 | Old era listeners never settle later commands | Verified (repair) | `:607` `it('executeCommand: a command dispatched after reconnect settles only in its own connection era')` |
| Opt-in timeout fires | C6.3 | Typed `timeout`, `remoteEffect: 'unknown'` | Verified (repair) | `:642` `it('executeCommand: rejects with a typed timeout outcome when timeoutMs elapses')` |
| Timeout boundary | C6.3 | Settles exactly at `timeoutMs`, never before | Verified (repair) | `:663` `it('executeCommand: timeout settles exactly at timeoutMs and never before')` |
| Timeout absent/early-complete | C6.3 | Resolves normally; timer cleared | Verified (repair) | `:692` `it('executeCommand: resolves normally when the command completes before timeoutMs')` |
| Abort mid-flight | C6.3 | Typed `aborted`, `remoteEffect: 'unknown'` | Verified (repair) | `:716` `it('executeCommand: rejects with a typed aborted outcome when the caller aborts mid-flight')` |
| Pre-dispatch abort | C6.3 | Typed `aborted`, `remoteEffect: 'none'`, no dispatch | Verified (repair) | `:734` `it('executeCommand: rejects before dispatch when the signal is already aborted')` |
| Abort after settlement | C6.3 | Resolved result untouched | Verified (repair) | `:750` `it('executeCommand: an abort after settlement leaves the resolved result intact')` |
| Shell safety: cwd escaping | C6.4 | CWD encoded with POSIX single quotes | **Repaired (was retained expected failure)** | `:771` `it('executeCommand: encodes cwd using canonical POSIX single-quote escaping')` |
| Shell safety: readFile path | C6.4 | Path encoded with POSIX single quotes | **Repaired (was retained expected failure)** | `:788` `it('readFile: encodes path using canonical POSIX single-quote escaping')` |
| Shell safety: writeFile path | C6.4 | Path encoded with POSIX single quotes | **Repaired (was retained expected failure)** | `:803` `it('writeFile: encodes path using canonical POSIX single-quote escaping')` |
| Shell safety: mkdir path | C6.4 | Path encoded with POSIX single quotes | **Repaired (was retained expected failure)** | `:827` `it('mkdir: encodes directory path using canonical POSIX single-quote escaping')` |
| Shell safety: editor rm target | C6.4 | `deleteFile` remote `rm -f` target single-quoted | Verified (repair) | `source/lib/editor-impl.test.ts` `it('deleteFile encodes the remote rm target with POSIX single-quote escaping')` |

## 9. Verification commands

- **Focused Contract Verification:**
  ```bash
  NODE_ENV=test pnpm test source/services/ssh-service.test.ts source/services/execution-context.test.ts
  ```
  *Result (2026-08-16):* 2 test files, 59 tests (all passing) in 527ms (Exit 0). Pre-repair baseline (2026-08-15): 47 tests (37 passing, 10 expected failures).
- **Ordinary red re-observation (2026-08-16):** the five in-flight-drop invariants run against the pre-repair `SSHService` (extracted read-only from `git HEAD`) settle never — 5/5 red immediately after event injection, no real waits.
- **Editor sibling:** `NODE_ENV=test pnpm test source/lib/editor-impl.test.ts` — 11 tests passing (Exit 0).
- **Broader Full-Suite Verification:**
  ```bash
  NODE_ENV=test pnpm test
  ```
  *Result (2026-08-16):* 485 test files, 6,262 tests — only the known
  settings-schema baseline failure remains (ambient `maxModelRequestDurationMs`
  setting test); all other files and tests pass.
- **TypeScript Typecheck:**
  ```bash
  pnpm typecheck
  ```
  *Result (2026-08-16):* Exited 0 (`tsc --noEmit` clean).
- **Formatting:** `pnpm exec prettier --check` on every touched file — clean. `git diff --check` — clean.

## 10. Repair record and Bug-to-Invariant analysis

### Repair 1: Unhandled In-Flight Transport Drop (Hang Defect) — REPAIRED

- **Level 1 — Bug (observed):** an active SSH connection dropping/erroring/closing, or an explicit `disconnect()`, while `executeCommand` is in flight left the promise pending forever.
- **Level 2 — Root Cause:** `SSHService.executeCommand` registered only `stream.on('close'|'data')` and `stream.stderr.on('data')`; there was no `stream.on('error')`, no client `'error'`/`'end'`/`'close'` handling during execution, and no registry of in-flight commands for a terminal event to settle.
- **Level 3 — System Weakness / Detection Gap (fixed by design):**
  1. *Representability:* every in-flight `executeCommand` now registers a settler in `SSHService.activeCommandSettlers`; a terminal client event settles all registered commands with a typed `SSHTransportError`, and each command also settles on stream close, channel error, `timeoutMs` elapse, or abort. A promise can no longer outlive the transport.
  2. *Boundary Contract:* `ISSHService.executeCommand` now documents typed rejection (`not_connected`, `exec_failed`, `connection_error`, `connection_end`, `connection_close`, `channel_error`, `explicit_disconnect`, `aborted`, `timeout`) with a truthful `remoteEffect` classification.
  3. *Detection Gap:* the in-flight drop scenarios are now ordinary passing tests through the public boundary (five per-trigger tests plus multi-command, partial-output, and reconnect-era tests).
  4. *Recovery Ownership Gap:* run loops and `RecoveryExecutor` rely on promises resolving or throwing; typed settlement restores that contract. No run-budget, global shell timeout, provider, or settings policy was modified.
- **Sibling Paths (audited):** `SSHService.readFile`, `writeFile`, `mkdir` all forward through `executeCommand` and inherit the repair; `cli.tsx:526` (`executeCommand('pwd')`) already catches errors; `glob.ts:52` / `grep.ts:129` availability probes throw through to the tool layer. The shell bridge (`execute-shell.ts:342-344`) forwards `cwd` only; it deliberately does **not** forward the global shell `timeout`/`signal` policy to the remote (imposing the local policy on remote commands is out of scope and would change remote execution semantics). Opt-in containment remains available to callers via `timeoutMs`/`signal` on `sshService.executeCommand`.

### Repair 2: Shell Parameter Metacharacter Injection (Safety Defect) — REPAIRED

- **Level 1 — Bug:** naive double-quote interpolation (`cd "${cwd}"`, `cat "${path}"`, `mkdir "${path}"`, heredoc `cat > "${path}"`) let paths containing `"`, `$VAR`, `$(...)`, or operators break out into arbitrary remote commands.
- **Level 2 — Root Cause:** `SSHService` interpolated raw strings into shell text without a dedicated escaping primitive; `editor-impl.ts:247` duplicated the pattern for `rm -f "${targetPath}"`.
- **Level 3 — System Weakness / Detection Gap (fixed by design):**
  1. *Representability:* `quoteShellArg` is now a single exported primitive (`'${v.replace(/'/g, "'\\''")}'`) applied to `cwd`, `readFile` path, `writeFile` path, and `mkdir` path inside `SSHService`, and to the editor's remote `rm -f` target. Hostile strings exist only as quoted test data.
  2. *Boundary Contract:* the four escaping proofs flipped from retained expected failures to ordinary passing tests at the service public boundary; a fifth covers the editor `deleteFile` sibling.
  3. *Detection Gap:* prior tests exercised only well-behaved path literals; every escaping test now pins the exact encoded command string including embedded quote/`$(...)`/operator payloads.
  4. *Sibling Consistency:* `grep.ts`/`glob.ts` already used ad-hoc single-quote escaping at the tool layer; the service boundary is now consistent with them. SFTP was **not** added — shell-text helpers (`cat`, heredoc, `mkdir`) are retained per the VP decision; binary/large-file transport remains an open product question (residual hypothesis 2).

### Residual Hypotheses — Resolved

1. **Command Timeout & `AbortSignal` in `ISSHService` — RESOLVED (opt-in).** `SSHCommandOptions` adds `timeoutMs?: number` and `signal?: AbortSignal` with compatible defaults: absent options preserve current behavior exactly (no timer, no abort listener). This is an **opt-in containment/cancellation boundary, not an invented default watchdog** — no default timeout is applied and no keepalive/ping was added. Guard-contract fields (recorded in `/tmp/sb06-remaining-report.md`): harm — an unbounded remote wait with no caller lever after a silent transport drop; owner — `SSHService` (enforcement) with the caller choosing the per-invocation bound; signal — elapsed wall time via a per-command `setTimeout`, or the caller's abort; action — settle the pending promise with a typed `SSHTransportError` (`timeout`/`aborted`); no channel-kill is fabricated and no blind replay is claimed; legitimate slow work — long-running but productive commands produce the same elapsed-time signal, so the bound is strictly opt-in per invocation; partial-work settlement — bytes received before settlement are carried in `partialOutput` and never presented as a complete result; recovery semantics — the caller receives the typed outcome and decides retry/fail-over; `remoteEffect: 'unknown'` forbids blind replay of non-idempotent commands.
2. **Binary / Large File Transport Safety — NOT RESOLVED (unchanged).** `readFile`/`writeFile` remain `cat`/heredoc text helpers per the VP decision; SFTP stays out of scope.
3. **Reconnect Listener Accumulation & Keepalive Defaults — RESOLVED.** Connection-lifecycle listeners attach once per client instance; `connect()` is single-flight (a call while connected resolves without reconnecting, verified at `:106`) and per-attempt `once` listeners remove each other on settlement. An old client/listener cannot settle a later command (verified at `:607`). Keepalive policy is explicitly **none**: no keepalive configuration and no background pings; drops surface through socket/stream events and typed settlement.
4. **Typed Ambiguous-Effect Model — RESOLVED.** `SSHTransportError.remoteEffect` distinguishes proven pre-dispatch (`'none'`) from ambiguous transport settlement (`'unknown'`); `exec_failed` is classified `'unknown'` because the exec callback may fire before or after the wire channel request.

### Audit result: owner paths forwarding `executeCommand`

Every owner path that forwards `executeCommand` (file helpers and shell bridge) now inherits typed in-flight settlement and escaped parameters; none was modified except `editor-impl.ts` (single-quote escaping). The shell bridge forwards `cwd` only, by design (see Repair 1 sibling audit). No child processes, background jobs, or nested agents are created by this contract's owner paths — SSH commands execute on the remote host; settlement is entirely promise-based.
