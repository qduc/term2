# Project Context

## Purpose and architecture

Term2 is a terminal AI assistant built with React (Ink), TypeScript, Node.js,
and an application-owned agent runtime. It supports interactive conversations,
non-interactive runs, shell execution, file changes, and approval prompts.

Application code lives under `source/`. The important boundaries are:

- `cli.tsx` assembles the app; `app.tsx` owns the interactive Ink UI;
  `non-interactive.ts` runs the conversation system without that UI.
- `agent.ts` defines the agent and registers tools.
- `source/services/conversation/conversation-service.ts` is the public
  conversation facade.
- `source/prompts/prompt-constructor.ts` assembles prompts; `prompt-profiles.ts`
  maps models to base profiles. Prompts and tool descriptions are product behavior.

## Current constraints and trade-offs

The [evidence-driven development experiment](docs/experiments/evidence-driven-development/README.md)
is active. Its repository-specific verification policy takes precedence over
conflicting testing guidance: permanent unit tests are prohibited; integration,
e2e, provider black-box tests, and existing static guards remain. Temporary tests
are allowed. High-risk changes require an independent verifier. Completed tasks
and escaped defects are recorded in the experiment's JSONL ledgers. The experiment
README contains the full policy and decision criteria; historical unit-test
references point to tag `unit-suite-baseline`.

Several agents share the primary checkout. Bug fixes and features use worktrees
under `.worktrees/` because sibling checkouts fall outside the shell sandbox's
write scope. Each worktree needs its own `pnpm install`; symlinked `node_modules`
previously broke command resolution. Keep the primary branch in place and preserve
other agents' uncommitted work. The [isolation procedure](docs/agent-context.md#parallel-work-isolation)
covers integration and cleanup.

UI components use `useTheme()` for colours and `useSkin()` for layout. Skins live
under `source/skins/<name>/`; component colour literals bypass this boundary.

## Evidence and institutional knowledge

Check [recorded test results](docs/test-results.json) when a verification run fails.
After a task's verification, append the tested commit/tree, command, environment,
counts, exact failures and evidence to its `runs` array, following existing fields
and using `null` for unknowns. Keep historical entries; append corrections or
resolving runs. Label pre-commit/dirty snapshots explicitly; never present them as
clean-commit runs. Record source commit hashes in a later documentation commit.
Historical matches identify candidate
pre-existing failures; compare the failure signature and environment before
classifying them, and reproduce on the base when the evidence is insufficient.
Check ancestry and intervening fixes; ancestry alone does not establish persistence.
Retain concise diagnostic signatures even when linking machine-local logs that
may expire. Do not record secrets or infer unrun tiers from focused checks.
Query a revision with `jq --arg sha <full-hash> '.runs[] | select(.commit == $sha)' docs/test-results.json`.

Repository docs provide orientation and rationale; the relevant implementation
establishes current behavior. Area-specific plans and service contracts are indexed
in [agent context](docs/agent-context.md#plans-and-area-specific-context).
Consult the relevant area documents before changing that area. The repository's
`verification` and `testing` skills describe evidence standards, risk levels,
and available test tiers for the experiment.

For shell probes and command-safety classification work, read
[Shell Safety For Agents](docs/agent-context.md#shell-safety-for-agents) before
executing probes; it preserves the repository's explicit safety constraints.
