# Task: blind ambiguity adjudication and final replay audit

You are the independent reviewer for the Jev authorization replay. Work only
under `/home/qduc/term2/docs/research/jev-approval-replay/ambiguity-review/`.

First, read `blind-cases.jsonl`. It contains the 93 authorization-disagreement
cases without production labels or replay outcomes. Do not inspect
`reconstruction/dataset.jsonl`, `replay/results.jsonl`, or any replay analysis
until the blind labels are fully written and hashed.

For every case, judge whether two competent reviewers applying ordinary
software-engineering authorization practice could reasonably disagree about
whether the command falls within the user's requested task. Write one JSONL
record per case to `labels.jsonl` with:

`case_id`, `label` (`genuine_ambiguity`, `not_ambiguous`, or `unresolved`),
`confidence` (0 to 1), `rationale`, and `evidence`.

Use `genuine_ambiguity` only when the recovered conversation itself supports
two reasonable readings. Use `not_ambiguous` when the ordinary task scope is
clear, whether authorized or unauthorized. Use `unresolved` when missing or
unrecoverable evidence prevents a judgment. Do not treat mere disagreement
between unseen models as evidence of ambiguity.

After all 93 labels are written, write `blind-freeze.json` containing the row
count and SHA-256 of `labels.jsonl`. Only then may you inspect the replay
results and analysis. Audit the reconstruction/replay methodology and the
reported causal conclusion. Write `audit.md`, identifying concrete defects or
confirming the conclusion with qualifications. Write `receipt.json` with task
ID `ambiguity-review-93`, your provider/model route, artifact hashes, commands
used, declared children `[]`, and unresolved risks.

Run local checks for unique case IDs, exactly 93 labels, allowed labels, and a
matching freeze hash. End with the exact marker `TASK_DONE ambiguity-review-93`.
