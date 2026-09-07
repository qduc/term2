# `run_code` oversized-output recovery review (2026-09-07)

## Disposition

The live observation was real interaction friction, but the current `run_code`
output path does not demonstrate data loss or an unsafe replay path. A large
rendered result is bounded at 30,000 characters, and the complete rendered
result is written before the bounded text is returned. The returned text carries
the artifact path in the same model-visible result.

The concrete gap was recovery guidance: the `run_code` description named the
30,000-character bound but did not tell the model what to do with the saved path,
or that a nested `read_file` envelope can itself report `truncated` and a
`fullOutputPath`. The description now teaches the narrow recovery operation:
read the exact artifact path, use a focused range or `grep` projection for a
large artifact, and do not repeat completed calls. No cap, replay policy, or
output API changed.

## Evidence and scope

The canonical log-friction plan records that a parent aggregate exceeded the
model-visible limit, was spooled, and then had to be queried again. That proves
the extra retrieval turn, not that the payload was lost. The same plan explicitly
keeps this lane separate from the already-closed run-code authoring-friction and
tool-output/effect-safety plans.

The reviewed contracts were:

- `docs/plans/log-friction-improvements-2026-09-07.md`: live observation and
  guardrail against arbitrary cap increases and automatic replay.
- `docs/plans/run-code-authoring-friction.md`: top-level `clip` already saves a
  retrieval artifact; the deferred M4 per-item redesign is not justified by the
  post-M1 measurement in that plan.
- `docs/plans/tool-output-and-effect-safety.md`: bounded context results must
  preserve a retrievable payload, and completed or ambiguous effects must not be
  silently replayed.
- `docs/plans/tool-performance-followup.md` and the run-code row in
  `docs/plans/guard-ledger.md`: the run-code display owner is the existing
  artifact writer and formatter, with spool failure reported as unavailable
  output rather than execution failure.

## Source-backed recovery path

The following behavior is present in the current source; it was not recreated
in this change:

1. `clip` in `source/tools/system/run-code/run-code.ts` checks the existing
   30,000-character display bound. For an oversized final rendering it first
   calls `saveOutputArtifact`, then formats the standard
   `Full output saved to \`<path>\`` note, and reserves room for that note in the
   returned result. The complete rendered text includes the result and tool-call
   summary.
2. If artifact storage fails, `clip` returns an explicit unavailable-tail note
   and says not to repeat completed effects. It does not turn a completed script
   into a script failure.
3. `serializeResult` handles a different boundary: an oversized structured
   nested-tool result is spooled as JSON and rejected to the script as a
   catchable error that names the tool, limit, artifact (when available), and
   completed-effect warning. It never slices a structured object into invalid
   JSON or silently shrinks its fields.
4. `createReadFileToolDefinition` has a separate scripted envelope. When its
   JSON envelope exceeds its result budget, it preserves metadata, sets
   `truncated: true`, writes the raw content, and exposes `fullOutputPath` when
   that path fits in the envelope. It binary-searches the returned content to
   fit the envelope without splitting a surrogate pair. Direct reads use
   `boundToolResultText`, which preserves the same standard artifact note.
5. `agent-factory.ts` does not apply generic string trimming to a nested scripted
   result, so the structured read envelope reaches `run_code` for projection.
   The final direct `run_code` result is already bounded by `clip` before the
   ordinary tool wrapper sees it.
6. `saveOutputArtifact` writes under the deterministic
   `SANDBOX_TEMP_DIR/tool-output` owner. `temp-sweep.ts` intentionally retains
   artifacts across turns and process exits, subject to the documented 24-hour
   age and dead-PID grace cleanup. This is durable retrieval for the session
   window, not permanent archival.

## Reproduction matrix

| Case | Observed contract | Disposition |
| --- | --- | --- |
| Oversized final string after one effect | `run-code.test.ts` verifies one effect execution, a result no longer than 30,000 characters, a saved artifact containing tail evidence and the call summary, and no replay instruction. | Safe bounded output with retrieval. |
| Artifact storage failure | The focused test verifies completed effects remain successful, the tail is disclosed unavailable, and the output tells the model not to repeat effects. | Honest loss when storage itself fails; no execution-state fabrication. |
| Oversized structured nested result | Focused tests verify a catchable error, artifact note, and completed-effect warning; no partial JSON object is delivered. | Safe rejection at the nested transport boundary. |
| Scripted `read_file` over its envelope budget | `read-file.test.ts` verifies `truncated: true`, valid JSON, `fullOutputPath`, complete artifact contents, and Unicode-safe slicing. | Bounded projection with an explicit second retrieval path. |
| Large parent aggregate / specialized read | The live record establishes a spool-and-requery interaction, while the source contracts above make the omitted material retrievable. | No reproducible data-loss defect in the `run_code` owner. Recovery guidance was insufficiently explicit, so guidance was added. |

The large-artifact path is intentionally iterative: a direct specialized read
may be bounded before a caller's projection, and a scripted read may expose a
bounded envelope. The contract is not “every projection is returned in full”; it
is “the consumer is told what was omitted and receives the next artifact path or
can narrow the read.” This avoids arbitrary cap increases while retaining the
full payload when storage succeeds.

## Tests and detection gap

The pre-change focused `run_code` suite passed 92 tests. A red proof was then
run after adding the two guidance assertions but before adding the description
text: the targeted test failed because neither recovery instruction was present.
After the minimal description change, the targeted test passed.

Final focused checks:

```text
NODE_ENV=test pnpm test source/tools/system/run-code/run-code.test.ts \
  source/tools/system/run-code/scripted-e2e.test.ts
PASS 2 files, 103 tests

NODE_ENV=test pnpm test source/tools/file/read-file.test.ts \
  source/utils/output/bound-tool-result.test.ts \
  source/utils/shell/shell-output.test.ts \
  source/utils/shell/temp-sweep.test.ts
PASS 4 files, 51 tests

pnpm typecheck
PASS

pnpm exec prettier --check \
  source/tools/system/run-code/run-code.ts \
  source/tools/system/run-code/run-code.test.ts
PASS
```

`pnpm test:changed` and `pnpm test:related ./source/tools/system/run-code/run-code.ts`
both ran 928 tests with 923 passing and four pre-existing environment/lifecycle
failures (one expected failure). The failures were the known non-interactive
YELLOW-history cases, scripted-adapter acceptance, and Ink hidden nested approval;
none exercised this output guidance. No provider black-box run was required:
the production change is confined to run-code description text and its local
test, with no provider, bridge, run-loop, registry, or non-interactive behavior
change.

The detection gap was actionable guidance coverage, not a missing retention
mechanism. Existing tests proved artifact creation and effect preservation but
did not assert that the public run-code description teaches the exact follow-up
for both top-level artifacts and scripted read envelopes. The two assertions now
pin those instructions.

## Limitations and non-goals

- Artifact retention is bounded by the existing temp sweeper; this review does
  not claim permanent archival or restart-independent identity.
- If storage fails, the omitted tail is genuinely unavailable and cannot be
  recovered by this lane. The result says so rather than inviting replay.
- A user-configured lower generic output trim can impose an additional outer
  presentation bound; no live evidence showed that this removed a run-code
  artifact reference, so no speculative cross-tool trim change was made.
- Generic parent aggregation and any future machine-readable artifact API remain
  outside this owner. A durable typed artifact store belongs to the deferred
  design recorded in `tool-output-and-effect-safety.md` if a concrete retrieval
  failure is later observed.
