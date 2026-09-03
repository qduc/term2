# Review: tool-toggle Phase 1 implementation

**Reviewed:** `tool-toggle` at `4e52578d`, against branch point `ce7a8e32`.

**Verdict:** **Needs revision before merge if this branch is intended to close all six findings from the design review.** The main-agent capability mask, scalar settings UI, and notice accumulation are sound. Two original product or enforcement gaps are explicitly deferred rather than closed: subagent enforcement and individual-tool control. The warning dependency map also remains incomplete. The filesystem-read finding is resolved only by narrowing the advertised control to one all-read switch; workspace-only Lite reads remain unavailable as documented.

## Blocking findings

### High — Disabled groups remain usable through subagents

This is the original design-review High finding, not a new edge case. The implementation now documents it accurately, but does not enforce toggles across the session tree.

- `source/services/tool-toggles.ts:3-10` explicitly limits masking to the main agent.
- `source/services/subagents/runtime.ts:64-79` constructs a separate `SubagentToolPolicy` and `SubagentToolFactory`.
- Execution runs build from that factory at `source/services/subagents/execution-runner.ts:178-203`; nested runs do the same at `source/services/subagents/nested-runner.ts:238-257`.
- `source/services/subagents/tool-policy.ts:813-915` selects file, web, and shell tools from role fields such as `canRead`, `canSearchWeb`, `canRunShell`, and `canWrite`. It never reads the twelve toggles or calls `resolveDisabledCapabilities`.

A parent with `tools.web.enabled=false` can therefore still invoke `run_subagent`, and that subagent can receive `web_search` and `web_fetch`. Shell and filesystem toggles have the same bypass. This is misleading for a kill-switch-shaped setting unless the user also disables all delegation.

`REPORT-tool-toggle.md:17-18` and `docs/plans/tool-toggle-setting-design.md:420-426` honestly defer this to M3. That makes the implementation internally honest, but the original gap is **deferred, not closed**. If Phase 1 promises only main-agent surface control, this is an accepted scope cut. If the six findings are the merge bar, it remains blocking.

### Medium — The motivating individual-tool use case is still unavailable

The original use case was to disable `web_search` while retaining `web_fetch`. Phase 1 cannot express it:

- `source/agent.ts:421-431` registers both tools under one `web` capability.
- `source/services/tool-toggles.ts:18-37` exposes one setting per capability group.
- `docs/plans/tool-toggle-setting-design.md:427-434,491-499` defers split controls to M2.

The implementation is coherent as a group-toggle feature, but this original requirement is **deferred, not closed**. Product acceptance must explicitly narrow the requirement, or M2 must land before this is called complete.

### Medium — The built-in warning map is incomplete

The two literal warning defects from the original review are fixed: Lite includes shell at `source/services/tool-toggles.ts:87-95`, and pending notices append at `source/services/session/session-manager.ts:166-170`. The replacement dependency map is nevertheless incomplete over actual composed guidance.

For example, `builtin:standard` deliberately returns no warning for `tools.shell.enabled` in `source/services/tool-toggles.test.ts:103-113`, while the Codex base prompt tells the model to search with shell commands and discusses shell invocation at `source/prompts/codex.md:24-32`. Base model prompts are also present beneath workflow profiles, yet the map gives Standard and Plan only file-write plus subagents, Orchestrator only subagents, and Mentor only mentor. Disabling shell under Standard, or file-write under Orchestrator or Mentor, can therefore leave active instructions referring to absent tools without the promised warning.

The map should account for the complete prompt: model-family base plus workflow fragments. At minimum, reverse the test that pins Standard plus shell as a no-warning case.

## Original six-finding closure matrix

| Original gap | Assessment | Evidence |
| --- | --- | --- |
| Subagent path coverage | **Open, explicitly deferred** | Separate subagent factory and role booleans remain untouched; see High finding. |
| Raw `capabilities.has(...)` reads | **Closed soundly for the main agent** | `source/agent.ts:325-338` creates one effective set. Mentor and all subagent registrations use it at `:561-596`. Repository search found no remaining `capabilities.has(...)` in `source/`, and `profile.tools.capabilities` has no other production consumer outside the resolver and `agent.ts`. The table test at `source/agent.test.ts:1464-1545` proves exact removal, including `ask_mentor` and the registered delegation family. |
| `filesystem-read-external` resolution | **Closed as an overclaim; authority split deferred** | No standalone external-read setting exists. `tools.fileRead.enabled` masks both capabilities at `source/services/tool-toggles.ts:21-27` and removes all Lite read tools. Thus no advertised control is a no-op. Lite still uses `allowOutsideWorkspace: true` at `source/agent.ts:489-510`, so workspace-only Lite reads remain impossible. This matches the smallest correction offered by the original review. |
| Individual-tool use case | **Open, explicitly deferred** | One web master still controls both `web_search` and `web_fetch`; M2 is the follow-up. |
| Array or scalar UI mismatch | **Closed soundly** | Twelve scalar booleans replace the array at `source/services/settings/settings-schema.ts:409-470`, with keys at `:991-1002` and defaults at `:1303-1319`. Schema introspection supplies true or false suggestions at `source/utils/value-suggestions.ts:233-267`; `SettingsValueMenuSession.tsx:30-40,94-110` submits one parsed scalar. There is no whole-array replacement hazard. |
| Warning map and composition | **Partially closed** | Lite plus shell is fixed and the sink composes. `runtime-setting-router.test.ts:209-237` exercises profile transition plus toggle warning in one apply; `session-manager.test.ts:81-97` proves both strings are retained. The dependency map is incomplete, and the reverse-order case required by `tool-toggle-setting-design.md:349-351` has no direct test. |

## Implementation quality

The post-resolution main-agent seam is correct. `source/agent.ts:325-367` derives capability-gated prompt flags from `effectiveCapabilities`, and registrations use `hasCapability` through `:420-603`. The original raw-read bypass for `ask_mentor`, `run_subagent`, and async controls is gone.

The table test is strong: `source/agent.test.ts:1518-1544` verifies every expected tool exists in the baseline and checks exact list equality after each toggle. The default-enabled test at `:1547-1573` protects the existing surface.

One acknowledged behavior remains surprising. For standard non-GPT-5 models, `grep` and `glob` sit inside the write branch at `source/agent.ts:529-540`, so `tools.fileWrite.enabled=false` also removes read-search tools. The implementation discloses and tests this; it is not hidden, but group boundaries are not exact.

Notice accumulation itself is sound. The router commits profile effects and then queues the toggle warning at `source/services/runtime-setting-router.ts:56-84`, while the session manager appends. A cross-service test asserting final `pendingModeNotice` in both input orders would protect the contract better, but current production code does not appear lossy.

### Additional documentation mismatch

`docs/plans/tool-toggle-setting-design.md:368-369` says disabling memory drops memory context and guidance. Guidance is gated, but `source/agent.ts:382-384` appends `memoryCapability.context` whenever the Profile memory context source is enabled, without checking `hasCapability("memory")`. The setting copy says memory tools, so retaining passive context may be acceptable; either the design claim or the code and tests should be corrected.

## Validation audit

### Independently reproduced

- Focused implementation set: **158 passed, 0 failed** across the seven named files.
- `source/lib/agent-factory.test.ts`: **37 passed**.
- Two client files named in the report: **5 passed**.
- `pnpm typecheck`: passed.
- Provider black-box at HEAD: **176 passed, 1 skipped** across 19 files.
- Provider black-box at clean `ce7a8e32`: **176 passed, 1 skipped**.
- At clean `ce7a8e32`, the three file-tool files produced exactly **6 failed, 108 passed**: two each in apply-patch, create-file, and search-replace. No `source/tools/file/` files changed on this branch, so these six failures are confirmed pre-existing.

### Full-suite and lane caveats

The report inventory is credible: 586 discovered non-E2E files and three expected-fail tests. My full run overlapped the provider suite and observed **7594 passed, 8 failed, 3 expected-fail, 2 skipped**, rather than the reported 7596 and 6. Six were the confirmed pre-existing file-tool failures. The other two were the InputBox split-chunk Alt+Enter test and candidate-gates truncation timing. Both files passed **68 of 68** immediately when rerun alone, so these are load-sensitive flakes, not branch regressions.

`pnpm test:lane` is also unstable under `isolate=false`. Both HEAD and clean-base runs failed with outside-workspace file tests, provider-management mock leakage, and an unhandled logging-file `ENOENT`; their extra session or approval failure varied. This supports the broad pre-existing-failure claim, but not the exact lane list as a stable result.

The provider row in `REPORT-tool-toggle.md:95` is stale. It records 28 passed, 1 failed, and 36 skipped after an early-close timeout. In this review the complete suite passed at both HEAD and base, including `openai-http.early-close`. The earlier timeout may have been environmental, but it is not currently reproducible and should not be presented as the current gate.

The report also labels `NODE_ENV=test pnpm vitest run` as an exact focused command while giving the seven path filters only in prose at `REPORT-tool-toggle.md:86-92`. Literally, that command runs all discovered tests. Include the paths in the displayed command for reproducibility.

## Recommendation

Do not describe this branch as closing all six design-review findings. It is mergeable only under an explicitly narrowed Phase 1 contract:

1. main-agent capability-family masters, not individual-tool controls;
2. no inheritance into subagents;
3. all-or-nothing file reads, with Lite external authority unchanged.

Before merge under that contract, complete the warning dependency map and update `REPORT-tool-toggle.md` with exact commands and current gate results. If the original six findings remain the acceptance criteria, implement subagent enforcement and the per-tool web split before merge as well.
