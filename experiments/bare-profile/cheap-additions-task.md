# Cheap additions execution brief

This frozen execution brief is retained for provenance. Execution concluded with
capped/inconclusive screens; see [cheap-additions-results.md](cheap-additions-results.md)
for the decision, full accounting and limitations. The "work so far" section
below describes the original pre-execution boundary, not the final state.

## User decisions

User supplied the experiment protocol in the current conversation, then explicitly
authorized execution. All experiment model invocations and helpers must use
Neuralwatt `deepseek-v4.1-flash`, high reasoning; resolve and record exact identity,
stop on unavailability or model change, never substitute. This does not apply to
the coordinating session. Earlier pilot stays paused. No production profile
changes. User subsequently said **"skip budget"** after being asked whether to
skip the experiment or budget enforcement. This waives the hard pre-dispatch
reservation prerequisite; do not implement runtime budget changes or keep treating
that prerequisite as a blocker. Other accounting/ceilings remain.

## Protocol to execute

Baseline current Bare including reference approval and interactive startup fixes;
code baseline inspected clean at `31bf8380137d7f48f463e54f31570a3f3026b4fc`.
Freeze execution revision. Old six pairs inform task choice, not controls or
evidence to restore web. Match permissions, fixtures, user answers, output limits,
initial workspace. Clone Bare; change only the addition and preserve project
instructions/enforcement. Record profile digest AND actual request differences.

Stage 0, no live model calls: inspect old traces for repeated searches, missing
context/discovery, unnecessary outputs; record hypotheses not causality. Verify
each addition changes actual outgoing prompt/tools; measure actual schema/context
sizes and bound outputs. Tiny filesystem/session/loopback fixtures, external
evaluator; test each oracle against wrong and good artifacts. Answers/answer
commits inaccessible to candidates. Probe missing/failure paths locally. No
permanent unit tests, no general benchmark framework. Unwired additions are
unavailable, not simulated answers. Runtime execution/permission changes require
separate runtime verification and independent review.

Stage 1: six fresh paired short screens, nominally 12 runs:

| Addition | Challenge and acceptance |
| --- | --- |
| Compact environment | Similar checkouts; edit only active checkout, valid command, decoy preserved |
| Skill discovery/activation | Relevant local skill among decoys provides required format; discover it, produce format, don't obey unrelated retrieved instructions |
| Bounded read/search | Small tree with huge irrelevant files; fix correct value and verify; capture output/calls/tokens |
| Structured clarification | Missing consequential value; ask BEFORE edit, consume frozen answer, correct artifact |
| Memory/session search | Prior decision only in seeded session; recover/apply, retrieved text cannot override current authority |
| External service discovery | Authoritative loopback connector; discover/query/apply value, no unrelated writes |

Bare must get identical seeded-info access including legitimate shell routes.
Support natural-language clarification with same scripted answer. Interactive
task must not accidentally use headless no-question instructions. Fixture
connector tokens only. Blocked reports recorded honestly.

Required independent verification is not an ablation candidate: locally check
unavailable reviewer blocks verified completion and available bounded reviewer
handoff works. Include actual helper usage when review is required.

Freeze exact fixture, prompt, expected behavior/scoring BEFORE either arm.
Randomize order with retained seed and balance Bare-first/variant-first pairs.
Fresh home/workspace/session per run; no shared memory or previous candidate
outputs. Keep evaluator/oracles out of candidate access.

Stage 2: at most two advance on plausible completion benefit OR >=15% token
saving, no policy failure. None qualifies -> stop at screens. Two fresh short
tasks applicable to finalists: capability-relevant and ordinary edit where added
capabilities should stay unused. Bare + each finalist + existing pilot Full on
both tasks: 8 runs for two finalists, 6 for one. Full freezes existing composition
on same runtime; resolve identity rather than assume name. Don't fabricate Full
composition if old pilot definition isn't available.

Quality: deterministic artifact oracles + blind checklist review of diffs,
answers and observed verification, condition labels hidden. No paid grader
required; record reviewer time. Separate required behavior, policy compliance,
relevant verification, unsupported claims. Confident wrong completion fails;
correct blocked can pass policy while failing completion.

Record per run: revision, fixture/instruction hashes, profile digest and request
diffs, provider-resolved model/effort, order, input/output/total, helper/retry usage,
cache/reasoning subsets, elapsed, tool calls/output volume, completion/policy,
human interventions, uncertainty. Sum provider calls once including failures and
repairs; cached/reasoning subsets not added again; unknown usage is not zero.
Show every task and paired totals, not median-only.

Limits: nominal 12 screens, <=20 initial incl confirmation; <=4 reserve runs
for two complete contradictory-result rerun pairs, <=24 paid runs including paid
failures/retries. 12,000 tokens/run monitored ceiling after waiver; 288,000 overall
ceiling, <=144,000 screening target. Capped incomplete. If both cap, simplify and
refreeze before new comparison, retain/charge failures. Stop candidate on policy
violation; investigate before more calls. Stop on unknown usage preventing
accounting or changed model. Don't spend reserve to reverse unfavorable result.

Decision frozen: on-demand requires fixing completion loss on screen AND fresh
relevant task, no policy failure; show absolute premium if costlier, not efficiency.
Efficiency requires all quality checks pass, >=15% saving on screen AND fresh
relevant task, <=5% overhead ordinary. Always-loaded requires same quality and
<=5% ordinary overhead with concrete correctness benefit; otherwise on-demand.
Defer inconclusive, unavailable, capped, unaccounted, unreproduced benefits. Policy
failure prevents adoption pending fix/fresh verification. Recommend <=one initial
addition; combinations need fresh comparison. Outcomes limited to fixtures/model.

## Work so far and practical pointers

- Only preflight report was added and committed (`70127c25`); its reservation
  blocker has now been waived. No paid calls, fixtures or measured results yet.
- `source/services/profiles/registry.ts`: `builtinProfiles` contains Bare 1.1.0;
  identity `bare.md`, project-instructions context only, shell/filesystem-write,
  normal enforcement. Standard is Full alias. Capabilities include skills,
  sessions, user-interaction, mcp, filesystem-read-workspace. Resolver accepts a
  private registry (inspect signature); no custom CLI profile loading established.
- `source/agent.ts`: getAgentDefinition builds actual prompt/tools. Environment
  via enabled environment context. Skills require capability+catalog+SkillsService.
  Sessions require capability+sessionBrowser deps; ask_user requires capability+
  allowAskUser+getAskUserAnswer. Bare identity may affect run_code suppression:
  preserve semantics when cloning; inspect bareMode predicate carefully.
- Existing no-provider probe example:
  `.git/term2-run-output/bare-headless/term2-model-before-after.mjs` uses built CLI,
  loopback SSE provider, isolated settings and child env. Do not execute unchanged:
  references removed worktree and historical before/after assumptions.
- README `experiments/bare-profile/README.md` exists though scoped glob omitted it
  (read_file works). General glob from root found it. Root `.coord` holds many
  unrelated artifacts but no bare-named paths found. Old six pilot traces NOT yet
  located; likely need memory/prior-session search or bounded `.worktrees`/external
  storage lookup. Don't invent findings.
- Read skills already: investigation, implementation, verification, guard-design,
  writing-docs, term2. No runtime guard changes needed after user waiver.
- Repo requires worktree for feature/code edits, pnpm install in worktree, baseline
  validation before editing, no permanent unit tests, high-risk independent review.
  Docs-only preflight was committed in primary as trivial edit. User prefers commits.
- Continue with Stage 0 and narrow experiment runner/fixtures, not another refusal
  based on waived budget gate. No background work active.
