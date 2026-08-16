# Domain shards

Milestone 3 runs non-overlapping domain assignments. This file is the boundary
definition those assignments are cut from, and it is the source of the `domainId`
values an explorer namespaces its test ids with.

Derived 2026-08-10 from the 458 test files at `53a4b061`. Every file lands in exactly
one shard; there is no overlap and no unassigned file. Shard sizes range from 12 to
44 files.

## Rules

The first matching prefix wins, top to bottom. Order matters: `source/lib/` joins
`runtime` before the general `source/` fallback can claim it, and
`scripts/provider-black-box/` is separated from the general `scripts/` rule.

| Shard | Files | Path rules, in order |
| --- | ---: | --- |
| `provider-blackbox` | 15 | `scripts/provider-black-box/`, `scripts/fake-codex-server*` |
| `session` | 44 | `source/services/session/` |
| `runtime` | 43 | `source/services/agent-runtime/`, `source/lib/` |
| `conversation` | 30 | `source/services/conversation/`, `source/utils/conversation/` |
| `subagents` | 21 | `source/services/subagents/`, `source/services/queue/`, `source/services/handoff/` |
| `approval` | 14 | `source/services/approval/` |
| `providers` | 39 | `source/providers/`, `source/services/providers/`, `source/services/models/` |
| `shell` | 27 | `source/utils/shell/`, `source/services/shell/` |
| `ui-components` | 44 | `source/components/` |
| `hooks` | 31 | `source/hooks/` |
| `tools` | 26 | `source/tools/` |
| `observability` | 17 | `source/services/logging/`, `source/services/cost/`, `source/services/retry/` |
| `settings-config` | 14 | `source/services/settings/`, `source/context/`, `source/contracts/`, `source/env-setup*` |
| `platform-services` | 33 | remaining `source/services/` |
| `utils` | 29 | remaining `source/utils/` |
| `prompts-commands` | 12 | `source/prompts/`, `source/commands/`, `source/slash-commands*` |
| `entrypoints` | 19 | remaining `source/`, remaining `scripts/` |

Regenerate the inventory the boundaries were drawn against with:

```bash
find source scripts -name '*.test.ts' -o -name '*.test.tsx' | sort
```

## Why these boundaries

Shards follow ownership seams rather than equal size, because step 3 of the explorer
brief forbids inferring cross-domain redundancy: a duplication claim is only usable
if both tests sit in the same assignment. Splitting a seam across two shards hides
exactly the redundancy the audit is looking for.

That is why `source/lib/` sits with `agent-runtime` — `agent-client` and the run loop
are one seam — and why `source/utils/conversation/` sits with the conversation
service rather than with `utils`.

`provider-blackbox` is separate from `providers` despite the shared subject. It is a
different suite tier with its own command and its own scenario-ownership standards
(see the `provider-testing` skill), so `retier_candidate` means something different
inside it.

`platform-services`, `utils`, and `entrypoints` are residual shards. They are defined
by subtraction, so they are the least coherent and the most likely to produce
`needs_review`. Schedule them last, once the rubric has settled.

## High-scrutiny shards

The plan's guardrails name approval routing, terminal input ownership,
queue/injection behaviour, prompt behaviour, provider fidelity, the Run Loop, and
shipped regressions as high-scrutiny. Those map to `approval`, `ui-components`,
`hooks`, `subagents`, `prompts-commands`, `providers`, `provider-blackbox`, and
`runtime`. Mandatory second review applies across a larger fraction of these shards
than of the rest, so budget them at roughly double the cost per file.
