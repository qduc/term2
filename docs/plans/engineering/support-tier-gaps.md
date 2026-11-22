# Close the Core check gaps

Status: plan. Waiting on the maintainer to choose the order, and on provider
credentials for the items marked "needs a live recording".

[Support tiers](../../reference/support-tiers.md) promises that every Core item
has at least one automated check that fails when the item breaks. This plan
lists where that promise does not hold and what closes each gap.

## How the gaps were found

Three read-only passes over `tests/`, `scripts/provider-black-box/` and the CI
workflows at commit `a96ecc7`, each opening the tests and recording which
assertion would fail. No test was run, so a gap here means "no asserting test
was found", and a covered item means "an asserting test exists", not "it passes".
The claims each work item rests on were re-checked with `grep` and are stated
with the symbol or file a reader can search for.

Surfaces and TUI commands are well covered by the e2e files under `tests/cli/`
and are mostly absent from this list for that reason.

## Work items, in proposed order

Ordered by what a miss costs, then by how likely the miss is.

### 1. Safety checks that do not run

1. **The real sandbox is now checked for writes, credential reads and the
   network.** These tests run the built CLI with the sandbox on and are not
   skipped where the tools are missing: the shell then asks for approval
   instead of running, and the assertions fail. The two new files are Linux
   only; Seatbelt has not been run with them.
   - Writes: the case "bare retains the outside-workspace edit approval
     boundary without asking headlessly" in
     `tests/cli/cli.integration.scenarios.ts` used to assert
     `toMatch(/exit [1-9]/)`, which a write to a missing directory also
     satisfied. On Linux it now asserts the target path and
     `Read-only file system`, the error of the sandbox's read-only mount, and
     a sibling case shows the same write inside the workspace succeeding.
   - Credential reads: `tests/cli/sandbox-credential-read.integration.test.ts`
     plants sentinels in `~/.ssh`, `~/.aws` and `~/.netrc` of a throwaway
     home, readable by Unix permissions, and a secret in the environment. The
     model's `cat` of each is denied, the variable is empty inside the
     command, an ordinary home file and a workspace file read normally, and
     no sentinel reaches the provider, stdout or stderr.
   - Network: `tests/cli/sandbox-network.integration.test.ts` counts what
     reaches a loopback HTTP server. A direct connection has no route; the
     proxy answers 403 until `term2 sandbox-network allow`; after it the
     request arrives; `sandbox.allowNetworking: false` and a revoke close it
     again.
   - ACP: the `integration` job sets `TERM2_ACP_REQUIRE_SHELL_SUCCESS=1`, so
     the shell cases in `tests/clients/acp/v1.integration.test.ts` and
     `tests/clients/acp-v2/serve.integration.test.ts` no longer pass on a
     refusal.

   Found, and open:
   - **A sandboxed command can read Term2's own credentials.** `denyRead`
     (`credentialFiles` in `src/tools/shell/sandbox/sandbox-policy.ts`) lists
     `~/.ssh`, `~/.aws`, `~/.netrc` and the like, and not Term2's settings
     directory. With default settings and no approval, `head` on
     `codex-auth.json`, `grok-auth.json` and `settings.json` there returned
     their contents to the model. A decision: which of those files the
     sandbox hides, given that a `term2` started inside the sandbox would
     then not find them.
   - The sandbox's proxy bridge is `socat TCP-LISTEN:3128`, which opens an
     IPv6 socket. On a kernel without IPv6 the bridge never starts and every
     proxied command fails with "Failed to connect to localhost port 3128"
     and no explanation. The network test names this cause when it sees it.
   - Done: `tests/cli/sandbox-network.e2e.test.ts`, the only check of the
     approval prompt and of reuse across linked worktrees, ran only with
     `RUN_SHELL_SANDBOX_INTEGRATION=1`, which nothing set, in a lane without
     the tools. It had not rotted. `owner()` in `scripts/run-ci-lane.mjs` now
     places it in the `test` lane, and that job sets the variable.
   - Two cases in `tests/session/logging/logging-failures.integration.test.ts`
     failed in a container running as root and pass in CI. They make a
     directory unwritable with `chmod`, which root ignores; that is the
     likely cause and was not confirmed.
2. **Answered: the `e2e` and `provider-black-box` lanes need no real sandbox.**
   Those jobs install no sandbox binaries, and none of their tests depends on
   one. `tests/cli/approval-mode.e2e.test.ts` and the provider scenarios call
   the shell with `sandbox: 'unsandboxed'`, which goes to approval without
   reaching the runner. `tests/cli/unattended-approval.e2e.test.ts` puts stub
   `bwrap`, `socat` and `rg` executables on `PATH` (`sandboxShims`) so that
   availability reports true. The remaining e2e files disable the sandbox. So
   these lanes test approval routing around the sandbox setting, and the
   sandbox itself is exercised only by the checks in item 1.
3. **Decided: the generated properties run in CI.** The `quality` job runs
   `pnpm verify:generated --seed 424242`: ten properties from
   `scripts/generated-verification/run.mjs`, six of them about approvals. The
   maintainer authorized it on 2026-11-21, which the pilot's `PLAN.md` required
   before any CI use. Before it was added, a seeded change that stopped
   `docker-host` from routing as a hard gate failed `approval.decision-table`
   on its sixth case. A full run with a fixed
   seed took about 17 seconds in a cloud container with no build, passed at
   `49edfe662`, and two runs with the same seed produced the same report apart
   from timings. Two limits on what it adds. `approval.decision-table` does not assert a route per
   gate: it generates request shapes at random and asserts on whether any hard
   gate applies, so each pairing of an `ApprovalHardGate` with an approval mode
   is covered only as often as 1,000 random cases happen to produce it. And
   behavioural tests still cover four of the sixteen pairs: `question` and
   `denied-read` in `off`, `docker-host` in `unattended`, and `docker-host` in
   `off` behind `RUN_DOCKER_HOST_CONTROL_INTEGRATION=1` on macOS. The pilot's
   `README.md` now gives the registered count.
4. **The workspace write boundary is now checked for the file tools.**
   `tests/cli/workspace-write-boundary.integration.test.ts` (headless) and
   `tests/cli/workspace-write-boundary.e2e.test.ts` (a person answering the
   prompt) run the built CLI with the sandbox off. `create_file` and
   `search_replace` are tried by absolute path, by `..`, through a symlinked
   directory and a symlinked file, into a sibling directory whose name starts
   with the workspace's, into `~`, and into `.term2/hooks`; each is held for
   approval, the refusal names the approval policy as the reason, and nothing
   outside changes. The cases cover each of `APPROVAL_POLICIES`. Not covered:
   the sandbox as the boundary for shell writes (item 1), `apply_patch`, and
   writes made from inside `run_code`. Findings:
   - Headless `--auto-approve` allows any `create_file` or `search_replace`
     outside the workspace, in every approval mode, including after the
     reviewer model has rejected it (`decideHeadlessApproval` allows every
     tool that is not the shell). A rejected shell command stays rejected.
     The flag's help says it skips confirmation, so this may be intended; it
     is not asserted either way.
   - With the sandbox off, a shell redirect to an absolute path under `/tmp`
     runs without approval in mode `off`, wherever the workspace is, because
     the path classifier treats `/tmp` as safe. Redirects through `..` or `~`
     are held. The tests assert only the held cases.
   - The comment on the existing real-sandbox case says the bare profile
     edits through the shell. Bare also has `create_file` and
     `search_replace`, which approval admits, not the sandbox.
5. **The shell and output limits are now checked.**
   `tests/cli/shell-limits.integration.test.ts` covers `shell.timeout`: a
   command past it is stopped, its whole process tree is gone before the model
   sees the result, a command that ignores the first signal is still killed,
   and an explicit `timeout_ms` on the call wins.
   `tests/cli/shell-background-timeout.e2e.test.ts` covers
   `shell.backgroundTimeout`, which applies only to background jobs, and those
   exist only in the TUI. `agent.maxStreamOutputChars` turned out to limit the
   model's streamed text per request, not tool output: text past it fails the
   turn, the limit is inclusive, and reasoning past it is cut without failing.
   Tool output is cut by `tools.maxOutputChars`, checked in
   `tests/cli/tool-output-limit.integration.test.ts`: `shell` keeps both ends
   and says how much went, `run_code` and `read_file` keep the start, each cut
   names a file holding the whole output, and the same calls under three
   limits are cut or passed whole as the setting says. Not covered: Windows,
   and a foreground command moved to the background in the TUI.

### 2. Providers

Every built-in provider and custom type except `opencode` is Core. No automated check contacts a
real provider: pull-request CI is offline, `publish.yml` runs the static guards
and `pnpm test:integration`, and the one scheduled workflow,
`model-catalog-update.yml`, fetches the OpenRouter model list without sending a
model request. That stays the case by decision (item 13); the aim of this
section is a real recording behind every provider, replayed offline.

6. **Grok now has adapter tests; what they leave out.**
   `provider-session-grok.blackbox.ts` and `provider-session-grok-client.blackbox.ts`
   run the built CLI with `--provider grok` against a loopback server, with a
   real `grok-auth.json` under an isolated config directory and the provider's
   own client-version lookup running unmodified, and Grok has a `grok-http` row
   in `provider-capability-matrix.ts`. They assert the `x-grok-client-version`
   header and where its value comes from (cache, installed `grok`, built-in
   constant), the conversation headers, `GROK_BASE_URL`, the lifecycle
   scenarios, and that a 426 from the proxy fails the run after one request.
   Grok does not chain responses, so its two-turn scenario asserts a full
   history replay. Not covered: the live fetch of the current client version
   and its cache write-back, token refresh through the provider, and credential
   import from `GROK_HOME`. Grok still has no recorded traffic (item 7).
   Writing the tests surfaced these:
   - Fixed: a 426 reached the user as the proxy's text, "Your Grok CLI version
     is outdated", with nothing saying what to do. `explainOutdatedClient` in
     `grok.provider.ts` now adds the version Term2 sent and what refreshes it:
     the version is looked up from x.ai and cached for six hours, so the
     remedies are deleting the cache file and updating Term2.
   - Fixed: a stream that ended early was reported as "OpenAI streamed
     response ended without a completion." for every provider that shares
     `openai-responses-model.ts`, and as "OpenAI-compatible …" for those that
     share `openai-chat-completions-model.ts`. Both messages no longer name a
     provider.
   - Fixed: `GROK_BASE_URL` redirected model requests but not
     `fetchGrokModels`. Both now use `grokBaseUrl`.
   - Decided 2026-11-22 and done: a failed `--json` run still emits `final`
     before `error`, because two tests and scripts read usage and the terminal
     cause from it, but `OutputState.endTurn` in
     `src/clients/headless/output.ts` now gives a failed turn no answer: an
     empty `finalText`, even when an earlier step had text, and no text a step
     streamed without being accepted (`evidence: 'text_delta'`) in `turnItems`
     (`withoutUnacceptedText`). Accepted items of earlier steps stay. Both
     fields used to carry the partial text of a stream cut short; that text
     still arrives as `text_delta` events.
     `provider-session-chat-terminal-errors.blackbox.ts` asserts it on both
     chat rows.
   - Confirmed, and not specific to Grok: with `agent.retryAttempts` at n, a
     provider that keeps answering 503 receives 2 × (n + 1) requests for n of
     1 or 2, and one request for n of 0. The same counts were seen for
     `openai`, `grok`, `codex` and both chat custom types. `physicalModelStream`
     in `src/model/retry.ts` makes n + 1 attempts, and the engine in
     `@qduc/agent-core` then retries the turn, which runs them again. The
     final error reports the engine's count, three, for six requests. A fix
     belongs in `@qduc/agent-core` and needs a decision on what n counts.
7. **Record what has only been faked.** Recorded fixtures exist for OpenAI over
   HTTP, Google, OpenCode's Chat and Anthropic protocols, and, recorded through
   OpenRouter, the `openai-compatible`, custom `openai` and `anthropic` custom
   types (`fixtures/openai-compatible-openrouter/`, `fixtures/openai-type-openrouter/`
   and `fixtures/anthropic-openrouter/`, each replayed by a test in
   `provider-contract.test.ts`). Those three show that each type's own adapter
   path handles a real service speaking that wire format; they are not captures
   of any other vendor's server, and `PROVENANCE.md` says so per fixture. For this
   probe the two chat types send identical requests, so the pair does not yet
   exercise anything that differs between them. Still checked against
   hand-written servers only: Codex and OpenAI over WebSocket, which wait on the
   WebSocket capture adapter `PROVENANCE.md` lists as outstanding; and Grok.
   Decided against: a recording for `llama.cpp` and the local presets. The
   maintainer's judgement is that they have nothing of their own on the wire:
   they speak Chat Completions, which the `openai-compatible` captures cover,
   and their type-specific request shape is asserted against the loopback
   server in `provider-session-chat-terminal-errors.blackbox.ts` and the
   stateless lifecycle file. A local server's own quirks are found by using it. A direct `api.anthropic.com` capture now
   exists (`fixtures/anthropic/`), but the model produced no thinking block in
   it, and the capture that does contain thinking blocks came through
   OpenRouter. No fixture therefore shows whether Anthropic's own API accepts a
   tool continuation whose request omits the preceding thinking block, which is
   what the `anthropic` adapter sends. That needs a probe that makes the model
   think before it calls the tool. OpenCode's
   Responses protocol is also unrecorded; `opencode` is Supported and the
   maintainer has no account, so it stays so.
8. **Done: the older fixtures no longer carry live ids.**
   `sanitizeFixtureEnvelope` used to write each live provider id as a key of
   the committed `placeholders` table, and six fixtures prepared before that
   was fixed still did. The raw recordings no longer exist, so they were not
   recaptured. Instead `pnpm provider:fixture:prepare --accept` was run on a
   copy of each committed fixture: the frames already held placeholders, so
   the sanitizer left every turn unchanged and rewrote only the table, which
   is now keyed by the placeholder. `fixture-security.test.ts` fails if a
   table is keyed by anything else. The ids remain in the repository's
   history; they are identifiers, not credentials.
9. **Login flows now have tests; what they leave out.**
   `tests/cli/oauth-login.integration.test.ts` runs the built CLI with
   `--codex-login` and `--grok-login`, and `tests/cli/oauth-login-paste.e2e.test.ts`
   drives the pasted-code entry over a PTY, both with
   `tests/helpers/oauth-login-fixture.ts`. They assert the authorization URL
   and its PKCE challenge against the verifier later sent, the state check, the
   token request, the credential file and its mode, the failure paths, and
   Codex's fallback from its first registered port to its second. The
   authorization hosts are constants with no override, so the tests leave the
   CLI unmodified and redirect `fetch` for those two hosts to loopback with a
   Node `--import` preload; certificate and name handling for the real hosts is
   therefore not exercised. The Codex cases bind ports 1455 and 1457 and fail
   with a message saying so when another process holds them. Not covered: the
   browser launcher on macOS and Windows, the pasted entry for Codex, logging in
   again to a stored account, and credential import from `CODEX_HOME` and
   `GROK_HOME`. Findings:
   - Fixed: a refused callback printed the label twice, "Codex login failed:
     Codex login failed: OAuth state mismatch". `loginFailure` in
     `src/app/cli-account-commands.ts` adds the label only to a message that
     does not already start with it, and the tests assert the exact line.
   - Fixed: `tokenRequestEncoding` in `PkceLoginConfig` was set by neither
     provider and is removed.
10. **Done: the error-scenario exclusions are gone for the Core types.**
    `provider-session-chat-terminal-errors.blackbox.ts` runs `native-error`
    and `incomplete-stream` for `runtime-openai-chat` and
    `runtime-llama-cpp-chat`, asserting the exit status, the error text, the
    `--json` events and the persisted failed turn. The two OpenCode rows keep
    their exclusion, and its reason now says the type is Supported. The three
    chat types behaved identically. Findings:
    - A stream that ends after partial text makes a `--json` run emit a
      `final` event carrying the partial text, and then the `error` event
      (open; see item 6).
    - Fixed: a provider that answered HTTP 500 was recorded as "Could not
      reach <provider> after 1 attempts. No model response was received."
      `terminalNotice` in `src/session/harness-host/index.ts` now says the
      provider answered with an error when the failure kind is `provider`,
      `rate_limit` or `authentication`, and keeps the engine's wording for a
      `network` or unclassified failure.
      `provider-retries-exhausted-notice.blackbox.ts` covers both.
    - Done: the older failure scenarios in
      `provider-session-resilience-scenarios.ts` asserted only a non-zero exit,
      no answer text and at least one request. They now go through
      `assertFailedRun` with a row of `FAILURE_EXPECTATIONS` per route and
      scenario: exit 1, one provider request, stderr equal to `error` plus the
      persisted message, stdout empty or the partial text the stream
      delivered, and a log whose turn ended `failed` with no response and no
      assistant item. What that showed:
      - Fixed: a connection dropped before any response was `network` and
        retryable, with a `/retry turn` notice, on the OpenAI, Codex,
        OpenRouter and chat routes, and `provider`, not retryable and without
        a notice on the Anthropic and Google routes, so it was never retried
        there. The AI SDK wraps undici's `SocketError` (`UND_ERR_SOCKET`) as
        the cause of an error with no status, and the classifier did not know
        that code. It is now in `UNDICI_RETRYABLE_CODES`, and the
        `early-close-retry` scenarios show the dropped request retried and the
        turn completing on both routes.
      - Fixed in the fixture: the Google route showed only `Internal Server
        Error` because the fixture's HTTP 500 body was not Google-shaped. With
        `{error: {code, status, message}}` the product shows the message.
      - Decided 2026-11-22 and done: a WebSocket closed before the terminal
        event is persisted as `network` and retryable on both lanes. The Codex
        lane wraps the close in `AmbiguousModelOutcomeError` so the request is
        not replayed on the same chain, and `toModelFailure` used to classify
        the wrapper, giving `provider` and not retryable; it now classifies
        the wrapped close (`describedFailure` in `src/model/failure.ts`). Only
        a failure with `connection_interrupted` evidence is unwrapped: the
        engine recovers those from the evidence, not from `retryable`, and a
        local-compaction summary already retried them. Other causes Codex wraps
        (a reset connection, a handshake 502, close code 4000) keep `provider`
        and not retryable, because the summary retry reads `retryable` without
        evidence and would start retrying them. Neither lane offers `/retry
        turn` after partial text. The four rows are now asserted.
11. **Done: the ledger is checked against the tests.**
    `reconcileExecutionsWithTests`, run by `provider-capability-matrix.test.ts`,
    compares the executed-scenario lists with the titles Vitest collects from
    the `provider-session-*` files. An entry no title names fails, and so does
    a required scenario whose test exists but is not listed. The link is a
    convention: a test that executes a ledger scenario has the id
    `<rowId>.<scenario>` in its title. The `provider-testing` skill records it.
12. **API keys from the environment are now checked.**
    `tests/cli/api-key-environment.integration.test.ts` runs the built CLI
    against loopback servers and asserts which key reaches the wire, in which
    header, for `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, the `anthropic`,
    `google` and `opencode` custom types' variables, and the web-search
    variables in `SETTING_ENV_VARIABLES`. Not covered: web-search keys given
    only in `settings.json`, and the "configured" state the provider picker
    derives from `CUSTOM_PROVIDER_ENV_KEYS`. Findings:
    - Precedence differs by provider. For OpenAI, OpenRouter and web search the
      environment wins over `settings.json`; for the custom types a stored
      `apiKey` wins over the environment. The tests pin both.
    - Fixed: with no OpenAI key anywhere the request was sent with the bearer
      value `placeholder`. `openai.provider.ts` now stops before any model
      request and says the key is not configured, as OpenRouter does, unless
      `OPENAI_BASE_URL` is set, because a local proxy may take no key. The
      model-list request to OpenAI's host is still made, without a credential.
    - Fixed: for a custom `google` provider the model-list request put the key
      in the URL as `?key=`, where proxies and servers log it. `fetchModels`
      in `openai-compatible.provider.ts` now sends it in `x-goog-api-key`, as
      the model request does.
13. **Decided against: a scheduled check against the real services.** The
    maintainer chose one-time recordings replayed in CI as sufficient. The
    consequence is accepted, not solved: a replayed recording fails when Term2's
    side changes, and cannot fail when a provider changes its wire format or
    auth under an unchanged Term2. That kind of break is found by using the
    provider. Recapture a fixture when such a break is found, and when
    `fixture-drift.test.ts` reports that the SDK a fixture was recorded with has
    moved.

### 3. Saved data across upgrades

14. **Snapshots of released data exist for the Core formats; extend them.**
    `tests/fixtures/release-data/1.4.0/` holds a conversation log, `settings.json`,
    `codex-auth.json` and `grok-auth.json` written by the 1.4.0 code itself
    (`pnpm capture:release-data`), with synthetic content, and
    `tests/cli/release-data.integration.test.ts` loads every snapshot directory
    through the built CLI: it resumes the conversation and checks the earlier
    turns and tool result reach the provider, checks the saved settings take
    effect and survive, and checks each credential file is read. A committed
    snapshot is never edited; `tests/fixtures/release-data/README.md` gives the
    rule and the capture command.

    The 1.4.0 snapshot also holds a conversation with a completed automatic
    compaction and one more turn after it, under `conversations-compacted/`.
    It was written by the release itself: a worktree of tag `v1.4.0`, built,
    and its CLI named to the capture script with `--cli` and
    `--only compacted-conversation`, which adds that one directory and refuses
    to touch a file that exists. The test resumes it with the current build
    and checks that the request carries the recorded summary, does not carry
    the assistant text and tool results the summary replaced, and still
    carries what came after. User prompts stay in the request through a
    compaction, so the test asserts their presence, not their absence.

    Still missing: a rotated session, which needs the TUI driven through a PTY
    and two linked logs; a log compacted by `/compact` or by a provider's
    native compaction; and the memory store, which is Supported, not Core. A
    snapshot has to be added at each release that changes a persisted format,
    and nothing enforces that yet.
15. **The version rejection is tested on the headless paths.** A log whose
    lines carry an unknown `v` is refused by `--resume <id>` with "unsupported
    log version", exit 1, no provider request and the file unchanged.
    `--resume ls` and `--resume last` go through `withNativeCatalogue`, which
    skips such a conversation. Fixed: stdout used to say "No saved
    conversations found." with the reason only on stderr, so after a downgrade
    a user's conversations appeared to have vanished. `listingText` in
    `src/app/cli-conversations.ts` now says how many saved conversations this
    version cannot read and why, and `--resume last` says the same when
    nothing readable is left. An empty directory still says none were found.
    `tests/cli/release-data.integration.test.ts` asserts the wording. Not
    covered: the TUI resume picker, and a log in which only later lines carry
    an unknown version.
16. **Decide whether `settings.json` gets a version field.** It has none, so an
    incompatible change cannot be detected on load; the snapshot test protects
    only the values it asserts on. Two related behaviours seen while capturing
    the snapshot: the file is written as a full dump of defaults, and that dump
    includes `memory.directory` as an absolute path computed on the machine
    that wrote it, so a copied settings file points memory at the old machine's
    path. Separately, a conversation log records its workspace as an absolute
    path and resume is refused from any other directory, so a moved or renamed
    project cannot resume its conversations.
17. **Test the automatic triggers.** Done for a custom `openai-compatible`
    provider: `tests/cli/automatic-compaction.integration.test.ts` (headless)
    and `scripts/provider-black-box/automatic-rollover.blackbox.ts` (TUI). They
    cover compaction when reported usage crosses
    `agent.contextCompaction.compactThresholdTokens`, the `enabled` switch,
    `native` mode refusing to fall back, `TERM2_SUPERVISED`, the rollover
    reminder at each of `agent.sessionRollover.milestones`, the hand-off and
    resume of a rotated session, and both firing on one request.

    Writing them showed that rollover is not automatic. The engine sends the
    model a reminder (`ContextMilestoneReminder`); the session rotates only if
    the model calls `session_rollover`, so the tests' fixture plays the model.

    Still untested:
    - Codex's native compaction request at the trigger, and OpenAI's inline
      `context_management`. Existing tests cover `/compact` and the threshold
      sent in the request.
    - The reminder deferring compaction (`canDefer`, in `@qduc/agent-core`),
      which needs a model with a catalogued context window.
    - Automatic compaction in the TUI, and a rollover in the middle of a tool
      round.

    Findings:
    - Fixed: the reminder was sent on every surface, but `session_rollover`
      is offered only when `sessionBrowser` is set, which
      `src/app/launch-tui.tsx` alone does, so a headless model was told to
      call a tool it did not have. `src/session/conversation.ts` now passes
      `contextMilestones` to the turn only when `modelRollover` is not false,
      the signal `bindDirectCapabilities` uses to offer the tool. The headless
      case is in `tests/cli/automatic-compaction.integration.test.ts`. ACP and
      the server take the same path and were not run.
    - Compaction compares the trigger with the usage reported inside the
      current turn. The first request of a turn has only the engine's own
      estimate (bytes / 4), so usage reported at the end of one turn does not
      compact the start of the next.
    - A summary larger than the span it replaces is discarded after the
      summarising request has been paid for.
    - `native` mode on a provider without a native endpoint records
      `compaction_started` and no completion. Not asserted either way.
    - Neither feature shows the user anything when it runs, except that a
      rollover's briefing appears as a user message.

### 4. Release

18. **Done: the publish is gated on the packed artifact.** `publish.yml` now
    packs the build and runs `scripts/release-smoke.ts` on the tarball before
    it publishes: the tarball is installed outside the repository and a
    recorded provider turn with a tool call is replayed against it. CI's `e2e`
    job runs the same two commands on every pull request, so the step is
    exercised before a release depends on it. Two captures are replayed: the
    Google one, and `openai-compatible/cli-release-turn-v1-openai-chat.json`,
    recorded through OpenRouter. Limits: the publish step packs a second time
    when it publishes, so the tarball that was smoke-tested and the one that
    is published are built from the same `dist/` but are not the same file;
    and no capture exercises the Responses or Anthropic wire formats from the
    installed artifact.

### 5. Small Core items without a check

**Each now has a check through the built CLI.**

- `/settings reset <key>`: `tests/cli/settings-reset.e2e.test.ts` resets a
  changed setting in the TUI and reads the default back from disk, from the
  running session and from the next model request. The TUI has no reset-all
  form; `reset()` without a key exists only in the settings service.
- `-r` and `--show-reasoning`: `tests/cli/reasoning-flags.integration.test.ts`
  reads the effort off the model request and the stream the reasoning arrives
  on. `--show-reasoning` does nothing in `--json` mode, where reasoning is
  always a stdout event, and the TUI ignores it.
- `grep` and `glob`: `scripts/provider-black-box/run-code-file-search.blackbox.ts`
  asserts what the model reads when they succeed, and that a path outside the
  workspace is refused under the default approvals. The model reaches both
  only inside `run_code`.
- Environment overrides: `tests/cli/settings-environment.integration.test.ts`
  runs each variable against settings.json, and fails when an entry of
  `SETTING_ENV_VARIABLES` is in none of its three lists. `DEBUG_LOGGING` and
  `DEBUG_BASH_TOOL` are listed there as not observed, with the reason.
- Skins: `tests/cli/cli.e2e.test.ts` now compares the idle screen with a
  layout record per skin (`LAYOUTS`). Tool and approval frames are not read.

Found while writing them, and fixed, each with a test that failed first:

- `-r` with a value outside `VALID_REASONING_EFFORTS` (`-r bogus`, `-r HIGH`)
  was ignored without a word. `applyModelOverrides` in `src/app/cli.ts` now
  rejects it the way an unknown `--provider` is rejected: exit 1, the valid
  values on stderr, no model request.
- `DISABLE_LOGGING=1` turned logging off (`parseBooleanEnv`) while the
  settings override read only `true`, so the setting showed `false` with
  source `env`. The boolean entries in `buildEnvOverrides` now share one
  rule. This changes three spellings: `LOG_FILE_OPERATIONS=0` or `no` used to
  mean on, and `DEBUG_LOGGING` or `DEBUG_BASH_TOOL` set to `0`, `false` or
  `no` used to mean on. An unrecognised value keeps what each variable did
  before.
- `grep` on a single file returned `line:text` without the path its
  description promises. Both backends now name the file.
- `read_file` cut by a small limit still headed the result with the full line
  range. A cut result now holds whole lines only, and its header and a
  `[truncated: ...]` marker name the lines present; of a single line longer
  than the limit it keeps the start (`markReadFileCut`).
- `glob` with `..` in the pattern's directory part (`../*.txt`) searched the
  workspace and returned its own files under the `find` backend.
  `resolveGlobSearchTarget` now moves that directory part into the search
  root, as it already did for an absolute pattern, so approval sees the
  directory that is read: refused in a headless run, and with approval the
  parent's own files. Not run with `fd`, which was not installed where this
  was written; the split happens before the backend is chosen.

## Supported items with no check found

Not release-blocking, listed so the tier is honest: remote SSH sessions, the
background shell job tools, `read_code_outline` and `code_context_search`,
`enter_worktree` and `exit_worktree`, `activate_skill`, `propose_goal`,
`ask_mentor` and the mentor role, `/goal` typed in the TUI, `/handoff`,
`/restart`, the budget panel, input history, background check-ins and the
headless wait limit, and web search beyond the tool being offered. MCP, tool
toggles and the memory tools had no check in the directories that were read;
`tests/app/memory/`, `tests/cli/quiet-profile.e2e.test.ts` and the ACP tests
mention them and were not opened.
