# Project Context

## Purpose and architecture

Term2 is a terminal AI assistant built with React (Ink), TypeScript, Node.js,
and an application-owned agent runtime. It supports interactive conversations,
non-interactive runs, shell execution, file changes, and approval prompts.

Application code lives under `src/`, one folder per layer; tests live under
`tests/`, laid out by the same layer names. `docs/architecture/layers.md` gives
the layer table, the import rules and how a message travels. The important entry
points are:

- `src/app/cli.ts` parses the command line and starts the TUI, a
  headless run, ACP or the server; `pnpm build` emits it to
  `dist/src/app/cli.js`, which the `term2` bin (`dist/cli.js`) imports.
- `src/app/application.ts` wires the layers together; `src/session/`
  owns a conversation's append-only log and `src/engine/` runs the turn.
- `src/session/prompts/prompt-constructor.ts` assembles prompts; `prompt-profiles.ts`
  maps models to base profiles. Prompts and tool descriptions are product behavior.

## Current constraints and trade-offs

The [evidence-driven development experiment](docs/experiments/evidence-driven-development/README.md)
is active. Its repository-specific verification policy takes precedence over
conflicting testing guidance: permanent unit tests are prohibited; integration,
e2e, provider black-box tests, and existing static guards remain. Temporary tests
are allowed. The user-authorized [generated verification pilot](docs/experiments/generated-verification/README.md)
permits persistent bounded generated properties, not restored example-based unit tests.
High-risk changes require an independent verifier. Routine task, defect, and
successful-test accounting was retired at the user's direction; keep concrete
failure lessons and debugging evidence in the relevant existing docs instead.
The experiment README contains the testing policy and decision criteria; historical unit-test
references point to tag `unit-suite-baseline`.

Several agents share the primary checkout. Bug fixes and features use worktrees
under `.worktrees/` because sibling checkouts fall outside the shell sandbox's
write scope. Each worktree needs its own `pnpm install`; symlinked `node_modules`
previously broke command resolution. Keep the primary branch in place and preserve
other agents' uncommitted work. The [isolation procedure](docs/agent-context.md#parallel-work-isolation)
covers integration and cleanup. Reports, manifests, and evidence for a task in
flight go in `.handoff/` (or under the task's experiment folder), never in the
repository root, which is governed by an allowlist check.


UI components use `useTheme()` for colours and `useSkin()` for layout. Skins live
under `src/clients/tui/presentation/skins/<name>/`; component colour literals bypass this boundary.

## Evidence and institutional knowledge

Every large module must have a maintained public-interface document throughout
its life; update it as the interface evolves.

When verification fails, consult the recurring failure notes in the `testing`
skill and relevant area docs. Historical matches are leads, not proof that a
failure is pre-existing: compare the signature and environment, inspect intervening
fixes, and reproduce on the base when necessary. Report the tested revision (label
dirty snapshots), command, meaningful failures and verification limits in the task
handoff. Retain a note in existing docs when it explains a cause, failed approach,
recovery or recurring debugging trap; do not recreate routine result ledgers.

Repository docs provide orientation and rationale; the relevant implementation
establishes current behavior. Area-specific plans and service contracts are indexed
in [agent context](docs/agent-context.md#plans-and-area-specific-context).
Consult the relevant area documents before changing that area. The repository's
`verification` and `testing` skills describe evidence standards, risk levels,
and available test tiers for the experiment.

For shell probes and command-safety classification work, read
[Shell Safety For Agents](docs/agent-context.md#shell-safety-for-agents) before
executing probes; it preserves the repository's explicit safety constraints.
