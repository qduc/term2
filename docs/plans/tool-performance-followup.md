# Log-driven tool performance follow-up

## Resume here

Implementation workspace: `codex/tool-performance-20260905`, based on `114acd70`.
User authorized implementation after the September 5 real-conversation audit.
The audit remains in the primary checkout at
`docs/research/tool-real-world-log-audit-2026-09-05.md`.
Separate log-skill work is owned by the `log_skills` subagent; this worktree
does not edit those skills. Validation outcomes and limitations are recorded below.

## Scope and guard contract

Harm prevented: unchanged deterministic Codex compaction rejection repeated at
each boundary; irretrievable run_code display overflow; avoidable script and
rollover briefing repairs.

Scope: AgentClient Codex boundary/manual compaction; run_code final rendering
and instruction text; rollover tool/continuation instructions. No worker VM,
approval, timeout, profile tool partition, or protected-history policy changes.

Classes: native-compaction admission after explicit incompatibility evidence;
run_code context bound with retrieval. Owners remain AgentClient and run_code's
renderer; recovery remains manual compaction/local fallback and existing output
artifact reads respectively.

Signal: structured 400/404/405/422 rejection at the compact endpoint, narrowed
for 400/422 to explicit compaction or request-option incompatibility. Network,
429, 5xx, malformed output, generic history validation and cancellation are not
evidence that a model lacks the capability. Automatic suppression is scoped to
the resolved model instance, not all models/providers. Manual retry bypasses
suppression and success clears it. A recreated model also starts fresh.

Action: continue ordinary work with unchanged history; in explicitly selected
`auto` mode, use the existing safe local fallback. `native` never silently
starts a local summarizer. First failure remains visible; subsequent suppressed
attempts are not fabricated failures. No in-flight tools are replayed or aborted.

Local no-cold-turn remains a protected-history refusal. Surface a bounded,
actionable notice per run; do not create synthetic user turns or discard active
work to manufacture a cut.

Output: retain the 30,000-character display limit and host byte limits. Spool
the complete rendered result using the existing artifact owner before clipping;
include the retrieval path inside the display budget. Spool failure must say
the omitted tail is unavailable without changing completed tool effects into
a retryable execution failure.

Configuration/defaults/migration: none. The user's explicit compaction mode and
threshold settings remain authoritative. Large valid output still completes;
temporary provider failures remain retryable by the existing path. Observability
records model, failure detail, retry/recovery policy, and output
artifact references without credentials or full prompts. Rollback boundaries:
compaction policy, run_code rendering/guidance, rollover guidance independently.
Ledger rows: new Codex boundary-compaction rejection entry and run_code output
retention entry in `guard-ledger.md`.

## Acceptance

- Red/green AgentClient regressions through real ApplicationRunLoop boundaries:
  repeated incompatibility, transient and generic failures, per-model scope,
  explicit retry, safe auto fallback, native-mode retention and cancellation.
- Real script execution returns bounded output with a readable complete artifact;
  short results avoid artifacts; spool errors preserve successful execution.
- Runnable bounded-batch examples preserve sibling results and patch guidance
  avoids nested template-literal hazards. Rollover instructions name the brief
  limit, durable pointers, and session-owned handle limitations.
- Focused tests, related/changed tests, typecheck, provider black-box and full
  isolated suite; failures classified with baseline/environment evidence.
- A small synthetic live Lite compaction and follow-up checks the merged request
  shape without sending real conversation history. This is a smoke check, not
  an accuracy benchmark.

## Verification and retrospective

Validation is complete; gate results and limitations are recorded below. No matched
solve-rate claim is part of this change.

### Class-level retrospective

Both defects were preventable. Native retry memory was absent from the initial
Codex compaction path (`17775973`); run_code's initial renderer (`21512184`)
clipped the final result independently of the existing artifact mechanism.
The protocol-shape fix itself was already merged before this follow-up.

| Question | Evidence and prevention |
| --- | --- |
| Representability | All native failures previously became the same retryable result. A narrow incompatibility classifier and model-instance admission state now distinguish explicit rejection from temporary failure. |
| Single source of truth | Final display retention now uses the existing output artifact owner and retrieval-note formatter; no second storage directory or retention policy. |
| Boundary contract | Tests cross actual run-loop continuations and actual script-host execution; they assert preserved effects/history and a readable full result. |
| Implicit coupling | Literal JavaScript examples depend on real tool return shapes. The description's exact read example is executed against one real file and one missing file. |
| Wrong assumption | A retry can succeed without changed inputs; a truncated display is sufficient; every missing read rejects. These assumptions are now contradicted by explicit regression cases. |
| Detection gap | Single-attempt success/failure and display-length checks did not prove retry admission or retrieval. Multi-continuation and round-trip artifact tests cover those missing seams. |
| Automation | Tests enforce classification, model isolation, cancellation, manual re-enable, fallback mode, effect preservation, and executable guidance. A general lint rule would not establish those behavioral properties. |
| Siblings | OpenAI native failure handling already has explicit request classification and session suppression (`openai-responses-model.ts`). Local compaction retains safe-cut/hard-fit checks; blocked no-cold-turn gets advice without weakening those checks. `bound-tool-result.ts` and shell rendering already spool; run_code now shares their storage owner. `run_agent_workflow` delegates output to the shared host, which rejects oversized output with an explicit error; its byte cap is unchanged. |
| Knowledge | Existing tests protected bounds but did not state that clipped successful results must remain retrievable. The guard ledger now states the retention and non-replay contract. |
| Observability | The audit found repeated failures in Sept 1–5 retained logs; introduction dates alone do not prove the first affected run. New native-failure metadata identifies whether automatic retry is suppressed. The skill side task adds bounded event/traffic recipes. |
| Origin | Latent retry/retention gaps in the initial paths, rather than a demonstrated solve-rate regression. Live Lite request compatibility is independently checked below. |

The whole defect class is not eliminated: host byte-limit rejection still occurs
before display spooling, and local compaction cannot safely cut a single active
user turn. Those boundaries remain explicit. Guidance changes have runnable
contract coverage but no matched model-outcome experiment yet.

### Live smoke evidence

Production Codex provider registry, HTTP transport, Luna, synthetic history only;
no tools and no real task transcript. September 5, 2026 at 12:59:28 UTC:
compaction returned HTTP 200 in 3.148 seconds with an opaque `compaction` item;
the next request sent that item and returned HTTP 200. The answer was:
“The project code is `cedar-47`, and no code has been committed.”
Both facts match the synthetic source. The compact request used
`parallel_tool_calls: false` and `reasoning.context: all_turns`.

Two preliminary probe runs compacted successfully but their follow-ups returned
400: the direct-provider probe omitted `providerOptions.store: false`. Reading
the bounded error body identified `Store must be set to false`; adding that
option made reuse pass. No application fix was inferred from those probe errors.
This proves basic artifact reuse, not long-task accuracy or a performance gain.

### Validation results

All commands ran in the implementation worktree with `TMPDIR=/tmp` for tests.

- Red tests reproduced repeated deterministic compaction calls (three instead
  of one), missing output artifact, missing no-cold-turn advice, and missing
  rollover guidance before the changes.
- Final focused run: `pnpm test source/tools/system/run-code/run-code.test.ts
  source/lib/agent-client.application-run-loop.test.ts` — 107 passed. The two
  rollover suites also passed (6 tests). The exact read example initially
  failed on the real missing-file string return, then passed after correction.
- `pnpm typecheck` and Prettier check on all changed TypeScript — passed.
- `pnpm test:changed` — 207 passed files, one skipped; 3,447 passed tests,
  two expected failures and two skipped. This preceded the final cancellation
  and runnable-read cases.
- `pnpm test:related` with all six changed production paths — 207 passed files,
  one skipped; 3,449 passed tests, two expected failures and two skipped.
- `pnpm test:provider-black-box` — 19 passed files; 176 passed, one skipped.
- `pnpm test` — 604 passed files, one failed, one skipped; 7,898 passed,
  two failed, three expected failures, two skipped (249.30 seconds).
  `CLI --help` exceeded its 10-second test limit during a 14.441-second first
  build; its isolated recheck passed (1.56 seconds total). The no-model-match
  assertion instead received `Unexpected server response: 401`; the same
  failure reproduced on unchanged primary source at base `114acd70`.
  The full suite is **not green**; no test timeout or unrelated CLI code was
  changed to conceal these results.
- `git diff --check` — passed.

The isolated base check used only the two CLI selectors, not a second full
suite. It established the matching 401 baseline; the build-time timeout is a
non-reproducing full-run failure, not proof of a source defect or proof that it
can never recur. Gate logs and the three synthetic probe results are retained
under the worktree's `.cache/tool-performance/`; the base check is
`/tmp/tool-performance-cli-baseline-20260905.log`.
