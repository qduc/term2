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

1. **Strengthen and extend the real-sandbox checks.** One check does run the
   real sandbox: the case "bare retains the outside-workspace edit approval
   boundary without asking headlessly" in `tests/cli/cli.integration.scenarios.ts`
   writes outside the workspace through the built CLI with default settings and
   asserts the file is absent. `cli-headless.integration.test.ts` runs it in the
   `test` lane, which installs bubblewrap, and `publish.yml` runs it again. An
   earlier version of this plan said no such test existed; that was wrong. What
   is still missing:
   - Its other assertion is `toMatch(/exit [1-9]/)`, which a failure unrelated
     to the sandbox would also satisfy. It should assert the denial itself.
   - No test shows the real sandbox refusing a read of a credential path. The
     denied-read tests in `tests/tools/system/run-code/shell.integration.test.ts`
     use a stub `ShellSandboxRunner` that prints "Permission denied".
   - The network policy is unchecked. `tests/cli/sandbox-network.e2e.test.ts`
     runs only when `RUN_SHELL_SANDBOX_INTEGRATION=1`, which nothing sets, and
     setting it is not enough: the file belongs to the `e2e` lane, which runs on
     `ubuntu-latest` without bubblewrap or socat, and a comment in `publish.yml`
     records that Ubuntu 24.04 runners reject bubblewrap's loopback setup. The
     test has to move to a lane on `ubuntu-22.04` with the binaries installed.
   - The ACP shell cases in `tests/clients/acp/v1.integration.test.ts` and
     `tests/clients/acp-v2/serve.integration.test.ts` accept either a sandboxed
     result or a refusal, so they pass whether or not the sandbox ran.
     `TERM2_ACP_REQUIRE_SHELL_SUCCESS=1` makes success mandatory and nothing
     sets it.
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
   Tool output is cut by `tools.maxOutputChars`, which has no test. Not
   covered: Windows, and a foreground command moved to the background in the
   TUI.

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
   Writing the tests surfaced product behaviour worth a decision:
   - A 426 reaches the user as the SDK's text, "426 Your Grok CLI version is
     outdated", with nothing saying what to do about it. Term2 is the client
     here, so the remedy is a Term2 or version-cache update, not a Grok CLI one.
   - On the same failure a `--json` run emits a `final` event with empty
     `finalText` before the `error` event.
   - An incomplete Grok stream is reported as "OpenAI streamed response ended
     without a completion."
   - `GROK_BASE_URL` redirects model requests but not `fetchGrokModels`.
   - A lead, not yet confirmed: when the 426 was temporarily made retryable
     with `agent.retryAttempts` at 2, the server saw six requests, which
     suggests two retry layers multiplying.
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
   WebSocket capture adapter `PROVENANCE.md` lists as outstanding; Grok; and
   `llama.cpp` with the local presets. A direct `api.anthropic.com` capture now
   exists (`fixtures/anthropic/`), but the model produced no thinking block in
   it, and the capture that does contain thinking blocks came through
   OpenRouter. No fixture therefore shows whether Anthropic's own API accepts a
   tool continuation whose request omits the preceding thinking block, which is
   what the `anthropic` adapter sends. That needs a probe that makes the model
   think before it calls the tool. OpenCode's
   Responses protocol is also unrecorded; `opencode` is Supported and the
   maintainer has no account, so it stays so.
8. **Re-prepare the older fixtures.** `openrouter/tool-continuation-v1.json` was
   replaced by a live capture of both sides, which closes the gap this item
   used to describe. What remains: `sanitizeFixtureEnvelope` used to write each
   live provider id as a key of the committed `placeholders` table. That is
   fixed for new fixtures, but the fixtures under `fixtures/openai/`,
   `fixtures/google/` and `fixtures/opencode/` were prepared before the fix and
   still carry live request and response ids there. They are identifiers, not
   credentials. Fixtures are never edited by hand, so removing them means
   running `pnpm provider:fixture:prepare --accept` again on the raw recordings,
   which are kept outside the repository.
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
   - A refused callback prints the label twice: "Codex login failed: Codex
     login failed: OAuth state mismatch". The tests assert the single label.
   - `tokenRequestEncoding: 'json'` in `PkceLoginConfig` is set by neither
     provider.
10. **Done: the error-scenario exclusions are gone for the Core types.**
    `provider-session-chat-terminal-errors.blackbox.ts` runs `native-error`
    and `incomplete-stream` for `runtime-openai-chat` and
    `runtime-llama-cpp-chat`, asserting the exit status, the error text, the
    `--json` events and the persisted failed turn. The two OpenCode rows keep
    their exclusion, and its reason now says the type is Supported. The three
    chat types behaved identically. Findings:
    - A stream that ends after partial text makes a `--json` run emit a
      `final` event carrying the partial text, and then the `error` event.
    - A provider that answered HTTP 500 is recorded as "Could not reach
      <provider> after 1 attempts. No model response was received."
    - The older scenarios in `provider-session-resilience-scenarios.ts` assert
      only a non-zero exit and no answer text, which a CLI that failed to
      start would also satisfy.
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
    - With no OpenAI key anywhere the request is sent with the bearer value
      `placeholder` (`openai.provider.ts`), where OpenRouter stops before any
      request and says the key is not configured.
    - For a custom `google` provider the model-list request puts the key in
      the URL as `?key=` (`fetchModels` in `openai-compatible.provider.ts`);
      the model request sends it in a header. A key in a URL is written to
      proxy and server logs.
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
    rule and the capture command. Still missing: a snapshot of the memory store,
    and a conversation containing a compaction or rollover fact, which could not
    be produced from a headless run. A snapshot has to be added at each release
    that changes a persisted format, and nothing enforces that yet.
15. **The version rejection is tested on the headless paths; one of them
    misleads.** A log whose lines carry an unknown `v` is refused by
    `--resume <id>` with "unsupported log version", exit 1, no provider request
    and the file unchanged, and the test asserts that. `--resume ls` and
    `--resume last` go through `withNativeCatalogue`, which skips the
    conversation with a warning on stderr while stdout says "No saved
    conversations found." So after an incompatible upgrade a user's
    conversations would appear to have vanished. Nothing is lost, but the
    message should say that conversations exist which this build cannot read.
    The test asserts the stderr diagnostic and the unchanged bytes, and
    deliberately not the stdout wording. Not covered: the TUI resume picker,
    and a log in which only later lines carry an unknown version.
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

18. **Gate the publish on the packed artifact.** `publish.yml` builds, runs the
    guards and the integration tier, and publishes. `scripts/release-smoke.ts`,
    which installs the tarball outside the repository and replays a recorded
    turn, is run by hand and has one fixture, for Google.

### 5. Small Core items without a check

- `/settings reset`, the `-r` short flag and `--show-reasoning`: not run by a test.
- `grep` and `glob`: only their error paths are asserted.
- Environment overrides: three of the entries in `SETTING_ENV_VARIABLES` are
  asserted, in `tests/config/approval-restart.integration.test.ts`.
- Skins: `tests/cli/cli.e2e.test.ts` waits for the composer under each skin and
  asserts nothing about layout.

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
