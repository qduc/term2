# Medium Term2 versus Pi: no accepted solutions

The live comparison ended at **18 of 20 planned executions, with zero accepted
outputs**. On the complete OpenAI cohort (five pairs), Term2 averaged **$0.0842**
and **10.25 observed minutes**, versus Pi **$0.1044** and **11.50 minutes**.
Both had 0/5 accepted outputs; lower cost on failed work does not demonstrate the quality goal.
Anthropic is incomplete: four ended attempts per runner, with all Pi attempts
truncated by timeout or budget. Neither runner has an accepted Anthropic output.

Both used the same medium historical OpenRouter migration task, medium reasoning,
application **sandbox off**, and **always approve**. Models: **gpt-6-luna** and
**claude-haiku-5-5**. Term2 Bare `d277aa0` and Pi 1.5.2 were unchanged.

Cumulative known native-priced usage is **$19.453047450**, with **$9.376** retained
uncertain reservations: conservative exposure **$28.829047450 / $30**. The next
$1.18 send could not fit. No inference is active. These are usage-based prices,
not invoices; one Anthropic 404 has unknown usage. Infrastructure retries and
exploratory runs remain in full accounting.

Read [final results](LIVE-RESULTS.md) for per-run outcomes, spreads, censoring,
uncertainty and exact blockers; [task](task.md) and [protocol](PROTOCOL.md) describe
the frozen comparison. [Budget transition](BUDGET30.md), [allowance](MEDIUM-ALLOWANCE.md)
and [recovery](RESUME.md) preserve the protocol history. No product optimization
was accepted; no merge, release or hosted CI acceptance is claimed.

## Reproducible evidence

[evidence.tar.xz](evidence.tar.xz) contains the historical source tar, frozen grader
sources and controls, exact executed producer snapshots, actor changes and source
hashes, CLI outputs, native request/response captures, complete cumulative ledger,
recovery lineage, independent audit receipts and read-only summaries.
[evidence-receipt.json](evidence-receipt.json) gives its size and SHA256. The archive's
internal manifest hashes every other included file. Credentials are excluded and
known configured credential values were scanned before packaging.

The standalone [OpenAI snapshot](openai-evidence.tar.xz) and its
[receipt](openai-evidence-receipt.json) preserve the earlier complete five-pair
snapshot. The initial blocked-attempt ZIP is superseded by the full final archive;
its historical version remains in commit `3f461d0dc`. Earlier non-medium wire bodies
are in `codex/bare-hillclimb-report` (archive SHA256
`44cb3058a940bce67ba296ac78a89f31770dae2afb8b2324358b512f932a9952`);
this archive retains their ledger entries.

`python3 summarize.py <campaign-dir>` recomputes descriptive results without model
calls. `prepare.py` and `grade.py` use the archived historical source, frozen helpers
and a Linux bwrap host. Grader network isolation is separate from disabled actor
sandboxing. Executed producer versions are immutable archived snapshots; current
scripts also include reporting/recovery changes. Reproduction of paid trials needs
a fresh explicitly budgeted ledger allocation; do not blindly launch this completed
campaign. No more live inference or grader controls were run for final reporting.
