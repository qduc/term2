# Resume here

Codex-style exec feasibility SPEC (this doc). Status: spec only, no
implementation started; user reviews before any build step is authorized.

Decisions already taken (do not re-derive):

- The Luna runaway is model-side; no early-content detector ships (331 FPs on
  repetition, 9 valid-executed-patch FPs on meta-leak windows; event contract
  carries counts, not content — see
  `docs/research/early-degeneration-evidence-2026-09-04.md`).
- The diff-content trigger hypothesis was FALSIFIED by paired repro (Luna and
  Sol both clean, byte-identical 5,866 chars — see
  `docs/research/luna-repro-result-2026-09-04.md`). Remaining suspect is
  server-side chained state, not content shape.
- Correction (verified this session, supersedes the A/B doc's caveat): Codex
  DOES give Luna file-writing — `tools.apply_patch` inside the `exec`
  sandbox JS program, 1,318 calls across 257 rollout sessions (verified by
  scan: 12,600 `exec` calls, `tools.apply_patch` substring in 1,415 inputs,
  `tools.exec_command` in 9,550, `yield_time_ms` in 10,915,
  `max_output_tokens` in 10,948). Control is therefore STRONGER than
  reported: Luna writes files under Codex 1,318 times with zero runaways,
  at apply-subset median 1,364 / p95 8,359 / max 41,089 chars — versus our 9
  drips at 100k on the same model. The asymmetry is real and now points at
  the tool SHAPE (bounded exec program vs unbounded diff string), not the
  workload. `docs/research/why-us-luna-degeneration-2026-09-04.md` §1 should
  be read with this correction (leaving the file in place; this note is the
  correction record).
- Held for the user (unchanged): maxToolArgumentCharacters budget,
  app restart, subsystem on/off, codex-no-system-input rework, file-tool
  redesign. This spec does NOT authorize any of them; it recommends.

Premises disproven (do not rebuild on them):

- "No output cap" as differentiator: endpoint rejects max_output_tokens for
  both harnesses.
- "Codex never asks Luna to write files": false per above.
- Truncated-continuation as drip trigger: all 9 heads are coherent JSON.

# Spec: Codex-style exec for Codex-family models

## 1. What Codex sends (verified from logs, not recollection)

One `custom` tool named `exec`. Each call's argument is a small JS program,
e.g. `const r = await tools.exec_command({cmd, workdir, yield_time_ms,
max_output_tokens}); text(r.output);`. Observed API surface inside programs:
`exec_command` (9,550), `write_stdin` (1,486), `apply_patch` (1,318),
`update_plan` (125), plus `view_image`, `web__run`, thread/goal methods.
Two per-call properties carry the value: `max_output_tokens` (model-chosen
output budget, typically 30000) and `yield_time_ms` (early return + resume
via `write_stdin`). File writes are `tools.apply_patch("*** Begin Patch…")`
— patch text embedded in a program, not a bare unbounded string parameter.

## 2. Safety analysis (first-class; the likely sink)

Our approval path (`shell.ts:748-802`) classifies the literal `command`
string via `validateCommandSafety`/`isMutatingCommand` BEFORE execution, and
`needsApproval` and `execute` must agree on the same string. A JS program
breaks this invariant three ways: (a) the shell command is constructed at
runtime (`cmd` may be concatenated, templated, or read from a previous
result — static classification sees source text, not the executed string);
(b) `apply_patch` inside the program is a second, independent mutation
channel that never passes our file-tool approval path at all; (c) `write_stdin`
resumes processes across turns, so the approved action and the eventual
effect are separated in time. Any exec design must therefore EITHER execute
programs in a real JS sandbox with capability-interposed `tools.*` (each
`tools.*` call re-enters our existing approval/execute path as if the model
had called that tool directly) OR restrict the program language to a
whitelisted template the classifier can still read (which surrenders most of
the flexibility). Treating program text as classifiable shell text is
unsound and must be rejected explicitly. New dependency surface (quickjs /
isolated-vm / worker-thread sandbox) is required for the full design; there
is no in-repo JS sandbox today.

## 3. What it replaces / duplicates

`source/agent.ts` (tool registration; new tools register here per
architecture skill), `source/tools/system/shell.ts` (foreground exec +
`max_output_length`), `BackgroundShellRegistry` + watches + output store
(background jobs, monitors, check-ins), and the approval/safety path above.
Overlap is near-total with background-shell: yield/resume ≈ monitor +
`getBackgroundShellJob` + `write_stdin`≈held-stdin (which we lack). Full exec
would duplicate the background subsystem's lifecycle in miniature inside
every program, then need bridging between the two (a yielded program holding
a shell child vs the registry owning it). Highest deletion-test risk in the
doc: an exec module that only renames background-shell steps must not exist.

## 4. Model-gating, cache, lane

Must be Codex-family-only (the `custom/exec` tool type and `additional_tools`
prefix are Codex-lane constructs; `toCodexResponsesTool` already branches on
`tool.type === 'custom'`). Per-model tool definitions change the
`additional_tools` prefix content, which is prompt-cache-keyed server-side
(`prompt_cache_key`); expect a one-time cache-miss per model switch, same as
today's native-patch toggle (`shouldUseNativePatchTool` in agent-factory).
Responses-Lite lane replays the prefix verbatim — no new lane work, but the
prefix grows (exec declaration + API description ≈ consuming cache on every
chained turn).

## 5. Milestones (cheapest useful first; each independently landable)

- M1 — Per-call output budget on the existing shell tool. Add optional
  `max_output_tokens` (or rename-path `max_output_length` alias) honored at
  execution/trim time, model-chosen per call, default = current 40k behavior.
  No sandbox, no new tool, no lane change. SHIPPABLE ALONE. Abandon rest if:
  model-chosen budgets don't reduce over-absorption vs the constant (measure
  on traffic: mean absorbed output per shell call before/after).
- M2 — Yield/resume WITHOUT programs: `yield_time_ms`-equivalent on shell
  (early return with output-so-far + a `write_stdin`-style resume via existing
  job id) reusing BackgroundShellRegistry instead of duplicating it.
  Abandon rest if: resume usage is ~zero in practice (the background
  subsystem's monitors may already cover the need).
- M3 — `apply_patch`-as-bounded-call (NOT full exec): expose patch text as a
  length-capped parameter on the existing file tool, mirroring the observed
  apply-subset distribution (p95 8.4k) while grandfathering legit 53k via
  chunked/continued calls. Only if M1–M2 prove insufficient AND the user
  authorizes the file-tool redesign (still held).
- M4 — Full JS-sandbox exec. Only if M1–M3 leave a demonstrated gap AND a
  sandbox dependency is accepted. Explicitly last.

Per-milestone abandon rule: each milestone must show measured value on
provider-traffic (budgets chosen, resumes used, patch sizes bounded) or the
pipeline stops there.

## 6. Recommendation

Adopt M1, evaluate M2, defer M3/M4. M1 is most of the benefit (model-chosen
budgets are the property that generalizes beyond Codex models) at ~zero risk:
a new optional parameter on a classified string, approval path untouched. M2
is worth speccing only after M1 lands. Full exec (M4) is NOT recommended now:
it duplicates the background subsystem, needs a new sandbox dependency, and
its headline benefit (bounded file writes) is already better served by M3-if-ever.
The corrected A/B strengthens the case for BOUNDEDNESS, not for the sandbox.

## 7. NOT covered / unknown until built

Whether Luna actually stays bounded under an exec-shaped tool on OUR lane
(the control is Codex's lane; lane differences — chaining, reasoning replay,
prefix shape — are uncontrolled). Exact cache-cost of a larger prefix.
Whether models use per-call budgets sanely or always pick max. M2's UX shape
(yielded-call rendering in Ink) is undesigned. No implementation is
authorized by this spec.
