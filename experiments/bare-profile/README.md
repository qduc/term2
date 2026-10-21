# Bare profile comparison

Production Bare keeps a short prompt, shell/file editors, project instructions,
and the root goal-reporting tool. It omits automatic memory, skills catalogs,
session catalogs, JavaScript workflows, and delegation. Required verification is
not waived by profile selection. The relevant implementation is `builtinProfiles`,
`buildPromptSpec`, `getAgentDefinition`, and `AgentClient.#goalStopCheck`.

## Baseline fixture

`fixtures/minimal-bare-v1.json` preserves the original Bare profile definition
from `c99f26d7`, with a short inline prompt, empty context sources, and shell/edit
capabilities. It is benchmark data, not an additional installed profile. An
isolated comparison harness can resolve it with a private registry. Reproducing
the original goal-workflow exemptions also requires the historical runtime;
loading the manifest into the current runtime does not restore those exemptions.
Always record which runtime and definition the benchmark used.

CLI session headers identify `activeProfileId`, `activeProfileVersion`, and
`activeProfileDigest`. The digest identifies resolved profile composition; it is
not a hash of the entire provider request. Record the checkout revision, task
specification, project instruction hashes, model/effort, permissions, and provider
configuration separately. Active-goal context and shared prompt addenda can change
without changing the profile digest. No token reduction or quality equivalence
has yet been established for this revision.

## Paired pilot

Freeze acceptance criteria before running either condition. Start with six tasks
and two runs per condition (24 runs): a small edit, a multi-file change, a lifecycle
change, a repository-policy case, a materially ambiguous request, and a legitimate
external-information task. Use the same model, effort, starting revision, task,
permissions, and controlled source material in each pair. Include required review
costs in both conditions. Correct clarification or an explicit blocked outcome
must be scored appropriately rather than treated as a wrong implementation.

For historical reconstruction tasks, isolate network access and remove reachable
answer commits. For tasks requiring external information, give both conditions the
same controlled sources. Keep the evaluator outside agent control. Validate each
oracle on the baseline and known-good revision, score the actual final workspace,
and archive tracked and untracked work before cleanup.

Proposed pilot targets are at least 50% lower median total tokens, no observed
new policy violation, and no paired loss of required behavior. Investigate every
quality disagreement. A small pilot cannot establish statistical equivalence;
predeclare a quality-loss margin and sufficient sample before making that claim.
Keep Bare opt-in while uncertainty remains.

## Accounting

Existing `assistant_turn.usage` records describe root whole-run cumulative usage
for that turn. Aggregate each turn once across all attempts, repair turns, and
retained predecessor sessions; do not add `displayUsage` to it. Preserve absent
usage as unknown rather than zero. Record `prompt_tokens`, `completion_tokens`,
`total_tokens`, `cache_read_tokens`, `cache_creation_tokens`, and
`reasoning_tokens` separately where supplied. Cache/reasoning fields may be
subsets of other counts: do not add them again to total tokens.

Required review is additional work. Completion-verification transition records
expose available helper charges through `costUsdMicros`; those charges are not
currently added to the foreground footer. A missing verifier token count or cost
means total accounting is incomplete, not free. Use available provider request
records for complete comparisons. Capture billed cost, elapsed time, acceptance
results, rework, human interventions, and incomplete runs alongside token usage.

Estimate base-prompt, tool-schema, and injected-context sizes separately from
provider-reported usage. Use an appropriate tokenizer when reporting token
estimates; bytes or characters are not tokens. A smaller first request alone is
not evidence of lower task cost.
