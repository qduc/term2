# Provider black-box red-proof evidence

**Gate:** D
**Captured:** 2026-08-01
**Evidence worktree:** `codex/luna-provider-red-proof-evidence` at `390ad73e`
**Production baseline:** `0be2cced`, whose `source/` tree is identical to `5f3bc83a`

This document records historical failures against pre-fix production code. The
red runs used loopback HTTP/SSE/WebSocket fixtures, isolated temporary state,
the shipped CLI, and no credentials or network provider calls. No production
source was changed in this worktree.

## Neutral test stack

The coordinator applied the neutral commits in this dependency order. The
second column is the resulting local commit after cherry-pick/reconciliation;
the original commits remain the provenance for the test-only changes.

| Original commit | Local result | Scope and accounting |
| --- | --- | --- |
| `a2406eed` | `6ae091ab` | Stateful harness, WS fixture, capability matrix, and harness tests only. |
| `44bd6130` | `c407079e` | Transient workspace-cleanup retry only. |
| `258e939f` | `1df50f9b` | Exact CLI-output fixture/test changes only. One declaration conflict in the fixture surface was resolved without behavior change. |
| `fe89a2ec` | `1941d4a9` | `provider-session-responses.blackbox.ts` only. The neighboring merge `af655cc5` is mixed and was not applied. |
| `aff39722` | `8984b566` | Initial stateless lifecycle scenario only. |
| `cc4b1a63` | `e4ddf563` | Stateless continuity assertions and PTY driver corrections only. |
| `b599bbb7` | `390ad73e` | Resilience, incomplete-stream, and restart scenarios only. |

The following behavioral commits were deliberately not applied to the evidence
tree: `4640429a`, `2c93d938`, `073f6619`, `cbae0acc`, `9436eb7c`, `0661049e`,
`680828d2`, `d87ad4cc`, and `a331fbf8`. The unit-test portions embedded in the
mixed `4640429a` fix were also not extracted; the black-box cases below are the
neutral proof. `af655cc5` was not cherry-picked because it includes the
production `680828d2` change and `source/lib/agent-client.ts` changes.

## Commands and fixed-tree evidence

The pre-fix CLI artifacts were built with the matching direct toolchain (the
worktree `node_modules` symlink was not used as a pnpm install target):

```text
/Users/qduc/src/term2/node_modules/.bin/tsc --build tsconfig.build.json
cp -R source/prompts dist/
chmod +x dist/cli.js
```

Focused runs in the coordinated `390ad73e` tree were:

```text
/Users/qduc/src/term2/node_modules/.bin/vitest run --config vitest.provider-black-box.config.ts --configLoader runner scripts/provider-black-box/provider-contract.test.ts --reporter=verbose
/Users/qduc/src/term2/node_modules/.bin/vitest run --config vitest.provider-black-box.config.ts --configLoader runner scripts/provider-black-box/provider-cli.blackbox.ts --reporter=verbose
/Users/qduc/src/term2/node_modules/.bin/vitest run --config vitest.provider-black-box.config.ts --configLoader runner scripts/provider-black-box/provider-session-stateless.blackbox.ts --reporter=verbose
/Users/qduc/src/term2/node_modules/.bin/vitest run --config vitest.provider-black-box.config.ts --configLoader runner scripts/provider-black-box/provider-session-responses.blackbox.ts --reporter=verbose
/Users/qduc/src/term2/node_modules/.bin/vitest run --config vitest.provider-black-box.config.ts --configLoader runner scripts/provider-black-box/provider-session-resilience.blackbox.ts --reporter=verbose
```

For a precise behavioral parent, the same neutral test files were copied into
temporary source snapshots made with `git archive` at `fe89a2ec`, `f8e4015b`,
`cc4b1a63`, `b599bbb7`, and `d87ad4cc`; each snapshot was built with the direct
`tsc` command above and run with Vitest `--testNamePattern` for the relevant
scenario. This avoided treating an earlier missing fix as evidence for a later
fix.

The coordinator supplied the fixed integrated result: `pnpm
test:provider-black-box` passed with **18 files and 150 tests**. That is the
fixed-tree green evidence for the scenarios in this document; the full pnpm
gate was intentionally left to the coordinator after integration.

## Historical red matrix

### Application Responses HTTP chaining

| Provider family | Exact scenario | Pre-fix parent and result | Behavioral fix |
| --- | --- | --- | --- |
| OpenAI Responses HTTP | `provider-session-responses.blackbox.ts`: `'openai' 'http' preserves two-turn response chaining` | `fe89a2ec`, the parent of `680828d2`; **1 failure**. The second request had `previous_response_id === undefined`, expected `resp-first`. | `680828d2` |
| Codex Responses HTTP | `provider-session-responses.blackbox.ts`: `'codex' 'http' preserves two-turn response chaining` | `fe89a2ec`; **1 failure** with the same missing `previous_response_id` assertion. The two WS variants passed at this exact parent, so they are not counted as red for this row. | `680828d2` |

This is the ordinary two-user-turn proof and is intentionally separate from
approval continuity below.

### Application approval continuity

At the exact parent `f8e4015b` of `073f6619`, the eight approve/reject cases in
`provider-session-responses.blackbox.ts` all failed at
`assertApprovalResume` (line 281):

- OpenAI HTTP/WS approve and reject: expected `body.previous_response_id` to
  equal `resp-tool-producing`, received `undefined`.
- Codex HTTP approve and reject: received `undefined`.
- Codex WS approve and reject: received stale `resp-warmup-0` instead of
  `resp-tool-producing`.

The cases cover both `openai` and `codex`, both HTTP/WS where supported, and
both approval decisions. The continuity fix is `073f6619`; `cbae0acc` is the
follow-up stale-call-id guard. The fixed integrated gate is green for these
approve/reject scenarios.

### Stateless provider lifecycle and OpenCode session identity

`provider-session-stateless.blackbox.ts` exports 24 typed IDs: three scenarios
(`two-user-turn`, `approval-approve`, and `approval-reject`) for each of these
eight explicit runtime/route rows:

```text
openrouter-http
runtime-openai-chat
runtime-openai-compatible-chat
runtime-llama-cpp-chat
runtime-anthropic-messages
runtime-google-generate-content
opencode-chat-completions
opencode-anthropic-messages
```

The exact pre-fix parent for the OpenCode fix is `cc4b1a63`, the parent of
`0661049e`. The two OpenCode scenarios failed the stable-header assertion:

```text
assertProviderRoute: x-opencode-session changed between requests
expected the first ses_... value, received a different ses_... value
```

This red proof is distinct for the Chat and Anthropic OpenCode aliases; sharing
the wire family does not collapse their runtime registration or lifecycle
claims. The fix is `0661049e`. The fixed integrated gate covers all 24 typed
stateless IDs.

The same exact-parent run also confirms the alias behavior: the OpenCode rows
reach the wire and fail only on session identity. The runtime Chat aliases use
the same underlying wire family but remain separate rows in the ledger.

### Restart and restored-history continuity

These cases required the precise parents because `5f3bc83a` predates several
unrelated provider fixes.

| Fix under proof | Exact scenario | Exact pre-fix result |
| --- | --- | --- |
| `d87ad4cc` | `provider-session-resilience.blackbox.ts`: `resumes a completed conversation from full history, then establishes fresh chaining`; `repairs an interrupted tool-bearing conversation without an orphan or stale response id` | At parent `b599bbb7`, both cases timed out waiting for a persisted conversation in the configured `TERM2_CONVERSATIONS_DIR`; artifacts were written under the default `Library/Application Support/term2-nodejs` path instead. |
| `a331fbf8` | The same two restart cases | At parent `d87ad4cc`, the completed case reached the second request but failed the `inputText` assertion because the restored assistant text was a serialized JSON string (`[{"type":"output_text","text":"restart-answer-1"}]`) rather than `restart-answer-1`; the interrupted-tool case exited before the requested resumed prompt state. |

The first row proves persistence-directory selection; the second proves
normalization of restored message/tool history. They are not counted as one
generic restart failure.

### Incomplete and terminal provider streams

At the exact parent `b599bbb7` of `9436eb7c`, the resilience test's
`incomplete` cases produced four real failures:

```text
codex-http.incomplete
openrouter-http.incomplete
runtime-openai-compatible-chat.incomplete
runtime-google-generate-content.incomplete
```

Each returned exit code `0` and stdout `partial\n`; the assertion requiring a
non-zero exit failed. OpenAI HTTP, Anthropic, and the Responses WebSocket
incomplete cases passed at this exact parent and are not counted as red for
this fix. The fix is `9436eb7c`.

At the exact provider-regression parent `5f3bc83a` (the source-equivalent
`390ad73e` run), the following additional terminal/error behavior was red:

- `openai-http.native-error` returned exit code `0` with stdout `\n`, although
  the test required a non-zero exit and no fabricated success.
- `openai-websocket.native-error`, `.incomplete`, and `.abnormal-close`
  returned exit code `0` instead of failing.
- `codex-websocket.reasoning` exited without observable final output; the test
  expected `fixture resilience answer` and received only `\n`.

These cases exercise the bridge/WS error handling and Codex WS event
normalization fixed in `4640429a`. The live post-output OpenAI WS non-exit
symptom from the provider-bug sweep was not reproduced as a bounded black-box
hang here; this document claims only the deterministic error/close red proof.

### Other provider-boundary regressions reached by the black-box suite

The registry contract and CLI tests at the `5f3bc83a` source parent produced
the following exact failures:

| Provider family / bug class | Exact scenario and assertion | Fix |
| --- | --- | --- |
| Runtime Chat Completions (`openai`, `openai-compatible`, `llama.cpp`) — missing application-owned streamed model | `provider-contract.test.ts`: Chat success/error/tool-fragment cases and the CLI runtime-provider case fail with `Custom provider 'fixture-provider' has no application-owned streamed model` (the runtime rows also exit before the requested PTY state or capture no provider request). This is one shared implementation bug, not three independent reds. | `4640429a` |
| OpenAI Responses request options | `provider-contract.test.ts`: `OpenAI Responses HTTP preserves request roles, tools, reasoning, and provider options` expected `prompt_cache_key === 'fixture-cache'`, received `undefined`. | `4640429a` |
| Anthropic reasoning request fields | Contract/stateless request-shape assertions expected `thinking: { type: 'enabled', budget_tokens: 4096 }`, received `undefined`. | `4640429a` |
| Google reasoning request fields | Contract/stateless request-shape assertions expected `generationConfig.thinkingConfig` with budget `4096` and `includeThoughts: true`, received `{}` or `undefined`. | `4640429a` |
| Terminal-only final text | `provider-cli.blackbox.ts`: `prints terminal-only response text exactly once` expected stdout `hello\n`, received `\n` with exit 0. | `4640429a` |

The fixed integrated gate is the green result for these rows. The request-shape
assertions are semantic fields, not complete-body snapshots.

## Baseline diagnostics not counted as separate bugs

The unqualified `390ad73e` runs were intentionally not used as the final proof
for later fixes:

- `provider-contract.test.ts`: 17 tests, 10 passed, 7 failed. The failures
  include the streamed-model seam, missing Responses `prompt_cache_key`, and
  missing Anthropic/Google reasoning fields. The streamed-model errors are
  counted above as the real escaped runtime bug; they are not called compile
  drift.
- `provider-cli.blackbox.ts`: 3 tests, 1 passed, 2 failed. The terminal-only
  failure is counted above; the runtime custom-provider failure is the same
  streamed-model seam.
- `provider-session-stateless.blackbox.ts`: 8 tests, 1 passed, 7 failed. The
  runtime Chat exits, native reasoning omissions, and rotating OpenCode headers
  were separated by exact-parent reruns; the three runtime Chat exits are one
  shared seam, while the OpenCode result is the `0661049e` proof.
- `provider-session-responses.blackbox.ts`: 22 tests, 10 passed, 12 failed in
  the broad pre-fix tree. The HTTP multi-turn and approval results were rerun
  at `fe89a2ec` and `f8e4015b`; broad-tree Codex WS timeouts are not substituted
  for those exact-parent results.
- `provider-session-resilience.blackbox.ts`: 34 tests, 19 passed, 15 failed in
  the broad pre-fix tree. Its mixed failures were superseded by the exact
  `b599bbb7` and `d87ad4cc` restart/incomplete runs above.

## Test-only compatibility adjustments

- The PTY helpers from `cc4b1a63` write ordinary text, yield a bounded 50 ms
  key-event gap, and write CR separately. This separates terminal key events;
  it does not wait for provider state or rely on an echo probe.
- Between completed turns, the scenarios capture output length/idle-prompt
  markers and wait for a newly appended idle `❯` frame before typing. No larger
  arbitrary delays or debug/input hacks were added.
- The `258e939f` reconciliation changed only a test/fixture declaration; no
  provider behavior was altered.
- Builds and exact-parent snapshots used the direct matching toolchain and a
  read-only source archive. No pnpm install, credentials, network provider, or
  unsafe tool payload was used.

## Exclusions and remaining gaps

- Chat tool-call argument-fragment accumulation is not a clean black-box red in
  this tree: the contract test reaches the earlier missing
  `getStreamedModel()` seam before it can assert the fragmented call. Its
  dedicated unit test is embedded in mixed `4640429a` and was intentionally not
  extracted. The fixed gate still includes the integrated unit coverage.
- The `callId`/`call_id` duplicate-key regression and Codex per-instance
  continuation-cache regression likewise have no independent black-box red
  after the earlier lifecycle seam; their mixed-commit unit proofs were not
  imported into this historical worktree.
- Chat `reasoning_content` response preservation is preempted for the runtime
  Chat rows by the same streamed-model seam. Anthropic/Google native request
  reasoning is independently red above.
- Direct real-provider Anthropic capture remains credit-gated and excluded;
  all evidence here is deterministic loopback traffic.
- The full fixed-tree provider gate was supplied by the coordinator and is
  recorded above. This worker did not rerun the full pnpm/provider suite or
  typecheck after integration.
