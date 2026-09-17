# M0-sandbox — long-lived stdio MCP servers inside term2's shell sandbox

**Status:** complete — spike only, no production `source/` change. Worker `W-ds`, branch
`mcp-m0-sandbox`, 2026-09-17. Brief: `.coord/mcp-code-mode/briefs/M0-sandbox.md`. Backs Decision 4
of [`docs/plans/mcp-code-mode.md`](../plans/mcp-code-mode.md).

Spike code: [`spikes/mcp/sandbox/`](../../spikes/mcp/sandbox/) (README there describes each script).

## Verification

Brief verify command, run from the worktree root:

```
["bash","-lc","cd spikes/mcp/sandbox && npx tsx long-lived-pipe.ts"]
```

Observed 2026-09-17 in `/home/qduc/term2/.worktrees/mcp-m0-sandbox`. Host: Ubuntu 24.04.4 LTS,
node v24.19.0, `bwrap` at `/usr/bin/bwrap`, **`socat` not installed**:

```
sandbox availability (term2 production config): missing_dependency: socat not installed
NOTE: host has no socat; using the labelled socat stand-in via config.socatPath.
PASS wrap :: wrapped bwrap --new-session --die-with-parent --unsetenv AWS_ACCESS_KEY_ID --unsetenv AWS_SECRET_ACCESS_KEY --unsetenv AWS_SESSI...
PASS message-1 info :: child pid=2
PASS message-2 echo :: {"echo":{"n":2},"pid":2}
PASS message-3 wait >=5s :: elapsed=5223ms stdout={"waitedMs":5200}
PASS message-4 echo after 5s :: pipes still open after 5705ms
PASS cleanup-no-leftover-child-processes :: no bwrap/apply-seccomp/echo child left after SIGTERM
PASS cleanup-no-mount-point-dotfiles :: workspace root has no bwrap mount-point placeholders
INFO session-lifetime sandbox artifacts still present (expected until process exit/reset()): ["claude-1000","claude-empty-v6RnDz","claude-empty-y37rWB","claude-http-dab69fd9ac068451.sock","claude-socks-dab69fd9ac068451.sock"]
elapsed total=7456ms (socat stand-in)
RESULT: PASS (7 steps, socat stand-in)
EXIT=0
```

Because this host has no `socat`, the spikes pass `socatPath` (a real `SandboxRuntimeConfig` field,
`binaryPathSchema`) pointing at `spikes/mcp/sandbox/socat-standin.mjs`, a ~60-line Node stand-in for
the two socat address forms the runtime uses. Every run prints which path it took. The stand-in is
a **fidelity limit**: it proves the plumbing (bwrap + unix-socket bridge + host proxy + live pipes),
not socat's exact framing/option semantics. Re-run on a host with real socat to close that gap.

Evidence labels below: **[observed]** = a command in this repo printed the quoted output;
**[code]** = read from the named file/symbol; **[UNVERIFIED]** = not observed.

## Verdict

**Mechanically feasible as-is; not production-ready without four changes.**

- The wrapped command is an ordinary child process from the parent's side. Spawning it with
  `stdio: ['pipe','pipe','pipe']` and exchanging newline-delimited JSON-RPC for minutes works with
  no MCP SDK, no pty, and no extra handshake. **[observed]**
- What blocks adoption is everything *around* the pipe: this host cannot sandbox at all (no
  `socat`); the sandbox runtime is one process-wide config whose `reset()` kills the proxy bridges
  a live server talks through; `acquire()` is a process-wide lease that deadlocks other runners
  while held; and a long-lived wrapped process defers bwrap mount-point cleanup for the session.

Required changes (seams in *Proposed integration shape*):

1. **One settled session config.** A server's config must not differ from the session config in a
   way that forces `SandboxManager.reset()` under a live server.
2. **Servers must not hold `acquire()`.** Wrap once, release, then spawn.
3. **Explicit teardown accounting.** Count live wrapped servers so `cleanupAfterCommand()` is only
   called when none are live, or force-clean after each server wrap.
4. **Per-server grants** for env vars and network domains that do not require turning on
   `sandbox.allowNetworking` process-wide.

## Q1 — `wrap()` output with live pipes for minutes

**Answer: yes.** `AnthropicShellSandboxRunner.wrap()` returns a shell command string that begins
with `bwrap ... -- /usr/bin/bash -c ...`. Nothing about it is one-shot: the sandboxed process is a
normal child, its stdin/stdout are pipes, and the bwrap parent stays alive as long as the child does.

**[observed]** `spikes/mcp/sandbox/long-lived-pipe.ts` wraps `node echo-jsonrpc.mjs`, spawns it via
`spawn(wrapped, { shell: true, stdio: ['pipe','pipe','pipe'] })`, and exchanges four JSON-RPC
messages, the third of which makes the child sleep 5.2s before replying:

```
PASS message-1 info :: child pid=2
PASS message-2 echo :: {"echo":{"n":2},"pid":2}
PASS message-3 wait >=5s :: elapsed=5223ms stdout={"waitedMs":5200}
PASS message-4 echo after 5s :: pipes still open after 5705ms
```

The child reports `pid=2`. That matches the runtime's documented layering (**[code]** the
`wrapCommandWithSandboxLinux` header comment): `apply-seccomp` becomes PID 1 of a nested PID
namespace and execs the shell that runs the server, so the server sees itself as PID 2. Nothing in
the stack inspects or closes stdin.

**[observed]** The wrapped string for the production config
(`spikes/mcp/sandbox/probe-wrap-command.ts`) shows the shape the server would be spawned under:

```
bwrap --new-session --die-with-parent --unsetenv AWS_ACCESS_KEY_ID ... --unsetenv OPENROUTER_API_KEY
  --unshare-net --bind <tmp>/claude-http-<id>.sock <same> --bind <tmp>/claude-socks-<id>.sock <same>
  --setenv HTTP_PROXY http://srt:<token>@localhost:3128 ...
  --ro-bind / / --bind <workspaceRoot> <workspaceRoot> --bind <tmpDir> <tmpDir>
  --tmpfs /home/<user>/.ssh --ro-bind /dev/null .../.npmrc --tmpfs /etc/ssh/ssh_config.d ...
  --dev /dev --unshare-pid --proc /proc
  -- /usr/bin/bash -c "bash -c \"<socat stand-in listeners>; apply-seccomp /usr/bin/bash -c 'node <server>'\""
```

Consequences for a stdio MCP server:

- The server's stdout carries **only** its own bytes; the sandbox adds nothing to stdout (the socat
  listeners redirect to `/dev/null`, and `--die-with-parent` keeps the tree tied to term2).
- `--unshare-pid` + `--proc /proc` mean the server cannot see host processes, and the host cannot
  signal it directly — term2 must kill the **outer** child (the `bwrap`/`bash` process it spawned),
  which is what `--die-with-parent` is for.
- A server that needs a tty (rare for MCP stdio, but some wrappers do) has no pty here; the M1
  connection manager should keep stdout/stderr as pipes, as the spike does.

**[observed]** Kill behaviour is clean once the parent stops the outer child: 1.5s after `SIGTERM`
no `bwrap`, `apply-seccomp`, or server process remained (`PASS cleanup-no-leftover-child-processes`).

## Q2 — process-wide constraints: `acquire()`, config clobbering

Both hazards are real and were reproduced.

### Q2a — `acquire()` is a process-wide lock, and holding it parks every other runner

**[code]** `source/utils/shell/sandbox/shell-sandbox-runner.ts`:
`acquire()` chains onto the static `#managerOperation` promise and sets the **instance** flag
`#heldLease`; `wrap()` on the lease-holding instance skips the lock, while `#withManagerLock` in any
other call chains onto the same static promise. `source/tools/system/shell.ts` calls `acquire()`
before its own `wrap()`, and `#initialize()` (inside `wrap`) calls `SandboxManager.reset()` whenever
the initialization key changes.

**[observed]** `spikes/mcp/sandbox/probe-lease-and-grants.ts`, stage Q2a:

```
acquire() held by the spike (as an MCP manager would for the session)
shell-style singleton.acquire() while lease held -> still parked after 1500ms
singleton.wrap() while lease held (same instance) -> resolved
other-instance.wrap() while lease held -> TIMEOUT(3000ms)
shell-style acquire() after release -> resolved
```

Reads: a sandboxed MCP manager that mimicked the shell tool's `acquire()`-around-everything pattern
would **deadlock the shell tool for the whole session** (its `acquire()` never resolves), and would
block any second runner instance (e.g. a per-subagent runner) outright. Holding the lease for the
session is therefore ruled out; the server path should wrap once, release, then spawn.

### Q2b — a later wrap with a different config resets the manager under a live server

**[code]** `#initialize()` keys on `JSON.stringify({cwd, config})` and calls `SandboxManager.reset()`
when the key changes. `reset()` (in `@anthropic-ai/sandbox-runtime` `sandbox-manager.js`) kills both
socat bridge processes and closes the HTTP/SOCKS proxies — the servers a **already-running**
sandboxed child is dialing through (`--bind <socket>` mounts a path that no longer listens).

**[observed]** same probe, stage Q2b — a live sandboxed server, then one unrelated wrapped command
with a different cwd:

```
live server, curl https://registry.npmjs.org/ -> {"httpCode":"200"}
live server, curl https://example.com/ -> {"error":"curl: (56) CONNECT tunnel failed, response 403"}
after an unrelated wrap with a different cwd/config:
  live server, curl https://registry.npmjs.org/ -> {"error":"curl: (56) Recv failure: Connection reset by peer"}
  live server, curl https://example.com/ -> {"error":"curl: (56) Recv failure: Connection reset by peer"}
```

The server process was still alive; its *network* was silently severed. A shell command run from a
different project directory (or with a different `readPolicy`/`allowNetworking`) is enough. There is
no error surfaced to the shell side either — only the server notices, as a connection reset.

## Q3 — what a sandboxed server loses, concretely

**[observed]** `spikes/mcp/sandbox/probe-capabilities.ts` runs `probe-capabilities.mjs` inside the
wrapped command for both `sandbox.allowNetworking=false` (term2 default) and `=true`.

### Env

```
env: host=76 child=35
env dropped that look secret-shaped: ["OPENAI_AGENTS_DISABLE_TRACING","OPENROUTER_API_KEY"]
env survived: [ALL_PROXY, CLAUDE_CODE_HOST_*_PROXY_PORT, CLOUDSDK_PROXY_*, DOCKER_*_PROXY, FTP_PROXY,
  GIT_CONFIG_PARAMETERS, GIT_SSH_COMMAND, GRPC_PROXY, HOME, HTTP_PROXY, HTTPS_PROXY, LANG, LC_CTYPE,
  NO_PROXY, PATH, PWD, RSYNC_PROXY, SANDBOX_RUNTIME, SHELL, SHLVL, TERM, TMPDIR, _,
  all_proxy, ftp_proxy, grpc_proxy, http_proxy, https_proxy, no_proxy]
sensitive presence: {GITHUB_TOKEN:false, OPENAI_API_KEY:false, ANTHROPIC_API_KEY:false,
  OPENROUTER_API_KEY:false, AWS_ACCESS_KEY_ID:false, SSH_AUTH_SOCK:false, NODE_OPTIONS:false}
```

**[code]** `source/utils/shell/sandbox/sandbox-env.ts` explains it: `ALLOWED_EXACT_KEYS` is
`PATH, SHELL, TMPDIR, TEMP, TMP, TERM, HOME, TMUX` plus `LANG`/`LC_*`; everything else is dropped
before bwrap even runs (the `credentials.envVars` unsets in `sandbox-policy.ts` are a second layer on
already-clean env). Practical consequences for real MCP servers:

- `GITHUB_PERSONAL_ACCESS_TOKEN`, `SLACK_BOT_TOKEN`, `API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`,
  `GOOGLE_*`, `AZURE_*`, `OPENAI_*`, `ANTHROPIC_*` style variables **never arrive** — those servers
  will fail to authenticate.
- A server's own non-secret config (`MCP_LOG_LEVEL`, `FOO_HOME`, `XDG_*`) is dropped too — the
  allowlist is value-agnostic, so the grant mechanism must be able to name arbitrary keys.
- Also gone: `NODE_ENV`, `NODE_PATH`, `NVM_*`, `SSH_*`, `XDG_*`, `HERDR_*`, `npm_*`. `TMPDIR` is
  **rewritten to `/tmp/claude`**, which does not exist on this host (**[observed]**
  `TMPDIR exists inside sandbox: false`); a server writing to `$TMPDIR` gets `ENOENT` while
  `SANDBOX_TEMP_DIR` (`/tmp/qduc/term2-nodejs`) is writable.

**[observed]** Env grants are a parent-side decision, not a sandbox-runtime knob — the same wrapped
command with one extra key in the env dict it passes to `spawn`:

```
child with MCP_SPIKE_TOKEN added to the parent env dict: stdout="granted-value" exit=0
child with the default createSandboxEnvironment() env: stdout="" exit=1
```

### Network

With the production default (`sandbox.allowNetworking=false`):

```
dnsRegistryNpm: {ok:false, code:"EAI_AGAIN"}
tcpCloudflare443: {ok:false, code:"ENETUNREACH"}
nodeFetchAllowed: {ok:false, code:"EAI_AGAIN"}
curlAllowed: {ok:false, code:"56", message:"curl: (56) CONNECT tunnel failed, response 403"}
curlDenied:  {ok:false, code:"56", message:"curl: (56) CONNECT tunnel failed, response 403"}
```

Everything is blocked, including `registry.npmjs.org`, which *is* on the built-in allowlist. Note the
mechanism: DNS itself fails (`EAI_AGAIN`) because `--unshare-net` removes the network namespace; only
proxy-aware clients (`curl`, npm, node with `HTTP(S)_PROXY`) can even reach the host proxy, and the
proxy then denies. With `sandbox.allowNetworking=true` the same probe gives:

```
curlAllowed: {ok:true, httpCode:"200"}                                  # registry.npmjs.org
curlDenied:  {ok:false, code:"56", message:"curl: (56) CONNECT tunnel failed, response 403"}
nodeFetchAllowed: {ok:false, code:"EAI_AGAIN"}                          # node fetch ignores HTTP_PROXY
```

`node`'s global `fetch` (undici) does **not** honor `HTTP_PROXY`/`HTTPS_PROXY` by default, so an
SDK that uses bare `fetch` inside the sandbox fails even when the domain is allowed. A sandboxed
stdio MCP server that talks to a remote API over `fetch` will need one of: a proxy-aware agent, a
shipped `undici` `ProxyAgent`, or an unsandboxed run. This is a real, non-obvious integration cost.

### Filesystem writes

```
workspaceRoot:   {ok:true}
workspaceScratch:{ok:true}
sandboxTmpDir:   {ok:true}                     # /tmp/qduc/term2-nodejs
tmpClaude:       {ok:false, ENOENT: mkdir '/tmp/claude'}
homeNpmCache:    {ok:false, EROFS: open '/home/qduc/.npm/_cacache/probe.txt'}
homeRoot:        {ok:false, EROFS: open '/home/qduc/.probe-write.txt'}
etcHosts:        {ok:false, EROFS: open '/etc/probe-write.txt'}
```

Reads: `/etc/passwd` and `~/.gitconfig` readable, `~/.npmrc` denied (`EACCES`), workspace
`package.json` readable, workspace `.mcp.json` readable (**[observed]** `ENOENT` only because this
worktree has none — `.mcp.json` is bound to `/dev/null` only when it exists, see Q5).

The `npx` case the brief calls out (**[observed]** `spikes/mcp/sandbox/probe-npx.ts`, with
`sandbox.allowNetworking=true`):

```
=== write to HOME/.npm/_npx (what npx -y needs) ===
stderr: "mkdir: cannot create directory '/home/qduc/.npm/_npx/probe': Read-only file system"
=== npx -y is-odd (default HOME cache) ===
npm error code EROFS ... path /home/qduc/.npm/_cacache/tmp/***
npm error rofs Invalid response body while trying to fetch https://registry.npmjs.org/is-odd:
  EROFS: read-only file system, open '/home/qduc/.npm/_cacache/tmp/***'
=== npx -y is-odd (explicit cache inside the workspace) -> sandbox-writable cache ===
exit: 1, stderr: "npm error could not determine executable to run"   # package fetched+ran; is-odd has no bin
```

So: `npx -y <server>` **cannot** work out of the box — it needs `~/.npm` (`_npx` staging and
`_cacache`), and only `/dev/null`, `/dev/tty`, `/tmp/claude`, `<home>/.npm/_logs`, `<home>/.claude/debug`
are writable outside the workspace (`getDefaultWritePaths()`, plus term2's `<workspaceRoot>` and
`SANDBOX_TEMP_DIR`). With `npm_config_cache`/`--cache` pointed **inside the writable workspace** it
works (fetch and extraction both succeeded in the observation above). Note that `~/.npm/_logs` *is*
writable, which is why npx could still write its debug log.

## Q4 — per-server overrides without weakening shell sandboxing

### (a) Env passthrough — easy, and already possible without touching the runtime

**[observed]** (Q3 above) the sandbox runtime's env filtering is *not* the gate for extra keys: the
child only ever sees what the parent puts in the `spawn` env dict. `createSandboxEnvironment()`
takes a `source: NodeJS.ProcessEnv` parameter that defaults to `process.env`, so a grant can be
implemented **inside term2** as an extra allow-set:

```ts
createSandboxEnvironment({ ...process.env, ...grantedVarsFromUserConfig }, { cwd, tmpDir })
```

The runtime's own `--unsetenv` list (`credentials.envVars`) is derived by `isSecretKey` from the
same dict, so a granted `*_TOKEN` would be unset again at the bwrap layer unless the credentials
section is also adjusted — i.e. a grant must be threaded to **both** `createSandboxEnvironment` and
`createSandboxRuntimeConfig({ env })`. That is a one-seam change (`sandbox-policy.ts` plus its
caller in `shell.ts`), and it cannot widen anything for shell commands because the grant is applied
only to the MCP server's spawn.

### (b) Network domains — cannot be per-server today; must not reuse the shell allowlist blindly

**[code]** `createSandboxRuntimeConfig()` returns `network.allowedDomains = copilotAllowlist` and
`deniedDomains = allowNetworking ? [] : ['*']`, `strictAllowlist = !allowNetworking` — **one list for
the whole process**, stored in the singleton `SandboxManager` config. `SandboxManager.updateConfig()`
mutates that shared config, so a grant for a server also grants it to every sandboxed shell command
(and vice versa) until reset. **[observed]** in `probe-lease-and-grants.ts` stage Q4a:

```
fresh live server, curl https://example.com/ before grant -> CONNECT tunnel failed, response 403
allowedHosts before grant: count=212 includesExampleCom=false
  same live server, curl https://example.com/ after URL-shaped grant "https://example.com" -> 403 (still denied)
  same live server, curl https://example.com/ after bare grant "example.com" -> {"httpCode":"200"}
  same live server, curl https://registry.npmjs.org/ after grant -> {"httpCode":"200"}
allowedHosts after grant: count=213 includesExampleCom=true
```

Two findings worth carrying into M1:

1. Grant patterns must be **bare hostnames**. `matchesDomainPattern()` (sandbox-manager.js) compares
the bare `hostname`; the URL-shaped entries that dominate term2's `copilotAllowlist`
(`https://github.com/login/*`, `https://api.github.com/user`, ...) can never match. The grep-able
evidence is the observation above: the URL-shaped grant is a no-op while the bare one works.
2. A live **already-running** server *does* pick up a later `updateConfig()` allowlist addition —
the proxy reads `config` per request. So a domain grant does not require restarting the server, but
it is process-global, so it leaks to shell commands.

**Existing approval machinery** — `source/utils/shell/sandbox/sandbox-network-approval.ts`
(`registerSandboxNetworkApprovalHandler`, `registerSandboxNetworkApprovalPauseController`,
`sandbox-network-approval-coordinator.ts`, `sandbox-network-store.ts`) — is *architecturally
reusable* and should not be avoided: the proxy that dials is host-side, so a sandboxed server's
outbound connection reaches the same `sandboxAskCallback` that `#initialize()` installs, and the
handler registered by `source/app.tsx` would render a normal prompt. Reasons it is not sufficient
as-is:

- It is **gated on `strictAllowlist`**. In `filterNetworkRequest` the callback is consulted only
  after the allow/deny lists miss **and** `strictAllowlist` is false. term2 sets
  `strictAllowlist = true` whenever `sandbox.allowNetworking` is false (the default), so in the
  default configuration no approval prompt can ever appear — the request is denied outright. Any
  reuse must therefore change the default network posture for sandboxed servers, which is exactly
  the global weakening Decision 4 wants to avoid.
- It is **one handler for the process**, with a UI coordinator that serializes prompts for one
  interactive surface; a server dialing during a turn would open a prompt mid-turn (same as the
  existing shell behaviour, so this is a product decision, not a blocker).
- The store has session/project scopes, but `isHostAllowed` is consulted *inside*
  `requestSandboxNetworkApproval`, again behind the same `strictAllowlist` gate.

**Recommended shape:** keep the shell sandbox as-is; give sandboxed MCP servers their own
`sandboxAskCallback`-equivalent path that (i) consults the existing
`sessionNetworkAllowStore`/`projectNetworkAllowStore` (so a user grant does not re-prompt), then
(ii) prompts via the existing coordinator, and (iii) writes the granted bare hostname into the
shared config via `updateConfig()` — accepting that the grant is process-global, or moving to a
per-server proxy once the runtime supports more than one config. Do **not** silently append server
config domains to `copilotAllowlist`; that would grant them to shell commands with no prompt.

## Q5 — cleanup: children, temp dotfiles

**[observed]** `spikes/mcp/sandbox/probe-cleanup.ts` (three wraps: one one-shot, one long-lived
server, one shell-style command) with a private sandbox temp dir:

```
ghosts after wrap #1, no cleanupAfterCommand(): [".bash_profile",".bashrc",".claude",".gitconfig",".gitmodules",".idea",".mcp.json",".profile",".ripgreprc",".vscode",".zprofile",".zshrc"]
ghosts after wrap #2 + cleanupAfterCommand() while server alive: [ ...same 12... ]
ghosts after server stopped + one more cleanupAfterCommand() (deferred: no forced reset): [ ...same 12... ]
ghosts after reset() (process-exit path): [".claude"]
.claude residue contents: []
processes after reset(): ""
sandbox temp dir after reset(): ["claude-empty-KE5vpt","claude-empty-Kx8hEr","claude-empty-PNqDsP","claude-empty-oGOB3px","claude-empty-sBLOC9","claude-empty-zzHnb5"]
claude-empty-* dirs created in private TMPDIR by 3 wraps: 6
VERDICT: deferred-cleanup-demo=CONFIRMED ghost-dotfiles=CONFIRMED
```

Reading it:

- **Ghost dotfiles are real and per-wrap.** Because `linuxGetMandatoryDenyPaths()` denies
  `.gitconfig`, `.mcp.json`, `.vscode`, `.claude`, ... in the cwd, bwrap creates empty mount-point
  files/dirs there; 12 appear in a directory that had none.
- **`cleanupAfterCommand()` is deferred while any long-lived sandboxed process is live.** The runtime
  keeps a process-wide `activeSandboxCount`, incremented by every `wrapCommandWithSandboxLinux()` and
  decremented only by `cleanupBwrapMountPoints()`. A server's wrap is never followed by
  `cleanupAfterCommand()` (the shell tool calls it after its own command exits), so the count stays
  positive, cleanup returns early, and the ghosts live in the user's working directory for the whole
  session. Note that stopping the server does **not** fix it: the count is per wrap, not per process,
  so it stays > 0 forever until `reset()`. `reset()` removed 11 of the 12; an empty `.claude`
  directory survived (`cleanupBwrapMountPoints` swallows `rmdirSync` errors). **[observed]**
- **`claude-empty-*` dirs leak.** They are `mkdtempSync` sources for the intermediate-component
  binds and are not tracked by `bwrapMountPoints`, so nothing ever deletes them: 6 for 3 wraps. They
  are in `SANDBOX_TEMP_DIR` (term2's own temp dir), so it is bounded garbage, not user-visible.
- **Children are clean.** After `SIGTERM` to the outer child + 1.5s, no `bwrap`/`apply-seccomp`/
  server process remains, and the proxy bridges are gone once term2 exits (`reset()` also runs on
  `process.once('exit'|'SIGINT'|'SIGTERM')`).
- **macOS: [UNVERIFIED]** — no macOS host was available; seatbelt has no mount-point mechanism, so
  the ghost-dotfile and `claude-empty-*` findings are Linux-only by construction, but the deferral
  of `cleanupAfterCommand()` is macOS-visible only through whatever seatbelt bookkeeping the runtime
  does there.

## Proposed integration shape (seams, not code)

All of this is M1 territory; nothing here was implemented.

**1. A sandboxed-server spawn path that reuses the existing runner, one wrap per server.**
New module `source/services/mcp/sandboxed-stdio-server.ts` (name illustrative) exposing
`spawnSandboxedStdioServer({ command, args, cwd, grant })`. It:

1. builds the session's settled config via `createSandboxRuntimeConfig({...})` — **the same
   arguments the shell tool uses** (plus grants), so the runtime's `initializationKey` does not
   change and `SandboxManager.reset()` is never triggered under a live server;
2. calls `getDefaultShellSandboxRunner().wrap(commandLine, { cwd, config })` once;
3. releases any lease immediately (it must not call `acquire()`, per Q2a), and
4. spawns the returned string with `stdio: ['pipe','pipe','pipe']` and
   `env: createSandboxEnvironment(grant.augmentedEnv, { cwd, tmpDir: SANDBOX_TEMP_DIR })`.

**2. Session-scoped config ownership.** `createSandboxRuntimeConfig()` currently embeds the session
decision (`readPolicy`, `allowNetworking`, `allowReadExtra`) and a server that needs a different
`cwd` is a different key. M1 should either (a) pin every sandboxed wrap to one config per session
and reject a differing server config with an actionable message, or (b) teach
`AnthropicShellSandboxRunner#initialize` to stop calling `SandboxManager.reset()` once a sandboxed
server is live (it needs a "live sandboxed children" count — the runner has no such state today).
(a) is cheaper and matches Decision 4's provenance idea: one config, per-server grants accumulate in
it before the first wrap.

**3. A grant object, not free-form config.** Introduce (in the new MCP config layer) something like
`SandboxedServerGrant { envPassthrough: string[]; networkHosts: string[] }`, sourced only from the
**user-level** config file (never from the repository's `.mcp.json`, per Decision 4), then:

- `envPassthrough` flows into `createSandboxEnvironment(source, ...)` and into
  `createSandboxRuntimeConfig({ env })` so `credentials.envVars` does not re-unset a granted key;
- `networkHosts` is **pre-registered** on the session's config before the first wrap whenever
  `sandbox.allowNetworking` is true, using bare hostnames (Q4 finding 1), and when it is false the
  server must surface the exact user-config line to add — the same "name the override" behaviour
  Decision 4 asks for;
- every granted host should be reported in the catalog/approval UI so a project server cannot
  acquire a domain silently.

**4. Cleanup accounting.** Two options, both small:

- after a **failed or dead** server (startup error, exit, `stop()`), call
  `shellSandboxRunner.cleanupAfterCommand()`; and
- for the deferral window, extend `ShellSandboxRunner` with an explicit
  `markLongLivedChildStart()/markLongLivedChildEnd()` pair (or a counter passed into
  `cleanupAfterCommand()`), and force-clean mount points when the server set empties. Until then,
  the deferred-ghost condition is a real user-visible cost of sandboxing project servers.

**5. Capability reporting.** When a sandboxed server fails to start, the error path should reuse
`sandbox-failure-classifier.ts` / `annotateFailure()` and phrase the failure as one of: no network
(proxy-blocked), `npx` cache unwritable (`EROFS` on `~/.npm` → suggest an explicit
`npm_config_cache` inside the workspace, or the project-local install), missing granted env var, or
sandbox unavailable on the host (`availability()` — see Blockers).

## Blockers and risks found

- **This host cannot sandbox at all.** `AnthropicShellSandboxRunner.availability()` returns
  `missing_dependency: socat not installed` (**[observed]**, `probe-availability.ts`), so the shell
  tool refuses every sandboxed command here and any sandboxed MCP server would refuse too. Socat is
  a hard dependency of the runtime's Linux network isolation (`checkLinuxDependencies()`); this is a
  pre-existing host condition, not a regression from this spike, and everything above was measured
  with a labelled socat stand-in passed via `SandboxManager`'s `socatPath` config field. Whether
  term2 should bundle/require socat is a separate decision outside this brief.
- **Prompt-cache / session-config coupling.** Because one config serves the whole process, a project
  server with a differing `cwd` or `readPolicy` would either be rejected (option 2a) or reset the
  manager under live servers (2b). Neither is acceptable silently; both need explicit error text.
- **`fetch`-based servers** silently lose network because undici ignores `HTTP_PROXY` (Q3). Worth
  a black-box scenario in M1, since it fails at runtime with a bare `EAI_AGAIN`.
- **`TMPDIR=/tmp/claude` does not exist** on this host (Q3): a server passing `$TMPDIR` to a child,
  or a language runtime creating temp files there, gets `ENOENT`. `SANDBOX_TEMP_DIR` is writable but
  is not what the child is told.
- **macOS is [UNVERIFIED]** end to end (Q5).

## Spike inventory

`spikes/mcp/sandbox/` (see its README): `sandbox-harness.ts` (drives the production runner/config/env),
`long-lived-pipe.ts` (brief verify command), `probe-availability.ts`, `probe-wrap-command.ts`,
`probe-capabilities.ts` + `.mjs`, `probe-lease-and-grants.ts`, `probe-cleanup.ts`, `probe-npx.ts`,
`socat-standin.mjs`, `echo-jsonrpc.mjs`. No production file was modified.




