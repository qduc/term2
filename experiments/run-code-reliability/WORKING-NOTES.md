# Reliability study working state

This is a handoff artifact, not an efficacy report. No live baseline or candidate
trials have run. The protocol is still being prepared, NOT frozen.

## User goal and authorization

The user explicitly asked to define success before running realistic experiments
and only apply methods proven to reduce errors without safety/task regressions.
The durable session goal records this. User chose fresh trials on
`codex/gpt-6-luna` and `orca/deepseek/deepseek-v4.1-flash-1017`, with
`codex/gpt-6.1-sol` independent review. All exact IDs were verified through
`list_models`. No OpenRouter authorization. Always commit finished coding work.

## Current artifacts

- Worktree `.worktrees/run-code-reliability`, branch
  `experiment/run-code-reliability`, base `24752ab3` (v0.34.0). Primary checkout
  was clean before isolation. `pnpm install --frozen-lockfile` succeeded here.
- `protocol.json`: one separately stored task-local instruction candidate:
  isolate independent read errors using allSettled/catch, preserve successful
  observations, do not replay whole batches. Not a canonical skill mutation.
- Six cases use actual shipped repo files (release readiness, provider
  inventory, signature constants, session schema, effect contract clean control,
  adversarial incident report). Twelve pairs across two models; 24 fresh CLI
  processes. Original synthetic value-record cases were replaced BEFORE trials.
- Strict practical promotion rules are in protocol.json: baseline >=6 script
  errors, reduction >=4 and >=30%, >=5 distinct workflow-case wins, each model
  improves, no per-pair error/call/retry regression, all candidate JSON oracles
  pass, both arms safe, candidate aggregate latency <=1.25 baseline, complete
  traces and independent review. Low error floor => inconclusive, no promotion.
  Cases are related, not independent statistical samples; no p-value claim.
- `run.mjs` is an UNVALIDATED draft runner. It copies fixture files, invokes
  real built CLI, captures NDJSON, compares exact final JSON and input hashes.
  Do not launch it until the three preflight problems below are resolved.
- `pnpm build` succeeded BEFORE any production source change. `dist` is ignored.
  No production source has been edited, and no improvement has been adopted.

## Verification already run

Baseline command (15 passing tests):

`pnpm exec vitest run --config vitest.integration.config.ts source/tools/system/run-code/shell.integration.test.ts source/services/workflow-evolution/ledger.integration.test.ts`

Same command must be rerun after changes. Package scripts require typecheck and
lint for TS changes. No permanent unit tests. Retain evidence, append completed
task to docs/experiments/evidence-driven-development/tasks.jsonl, commit own
files, integrate worktree following docs/agent-context.md. No live background
jobs or agents exist.

## Independent preflight review (actual completed agent)

Via `agent.run` in parent run_code bridge 38, agent ID
`run_code_bridge_38:agent:1`, model codex/gpt-6.1-sol, fresh read-only context.
Three must-fix findings (no trials run):

1. CLI `--auto-approve` plus scratch cwd is NOT containment. It inherits real
   environment and all tools. An adversarial fixture must not get shell/write/
   network/outside-read authority before review. Enforce capabilities, not just
   prompt restrictions or after-the-fact scratch inventory.
2. Source fixtures are read from live checkout separately per arm. Snapshot
   once before trials, retain all bytes/hashes, use exactly that snapshot in
   every arm; enforce paired inventory equality.
3. Reconcile `tool_started.toolCallId` against
   `command_message.message.callId`, require a single completed terminal, and
   classify missing/duplicate results as uncertain. Also prove every requested
   path was inspected from host traces, not just the agent's final answer.

## Immediate next step: containment seam

Avoid another large investigation. Safest simple option under consideration:
build a TEMPORARY experiment-only CLI variant with an adapter in
`getAgentDefinition` (source/agent.ts just before registerToolFormatters/tools
return). For BOTH arms expose only read_file + run_code, and wrap read_file's
execute to enforce exactly the listed paths inside the pinned scratch directory.
No shell, writes, network tools, nested agent bridge, MCP or other tools may be
reachable. Keep a retained patch as evidence; restore source after build so
no unproven production behavior ships. Validate denials deterministically before
live model runs; retain CLI hash and exact adapter revision. A separate small
fixture harness using production run_code is another option, but don't replace
the real provider/model loop with mocks and call it efficacy.

Relevant facts already inspected:

- source/agent.ts getAgentDefinition registers tools then run_code last.
  `createRunCodeToolDefinition` currently receives agentSpecBridge and optional
  mcpToolSource, so removing other tool definitions alone is NOT sufficient if
  those bridges remain accessible: omit bridges in experiment adapter or use
  a minimal fresh run_code definition without them.
- `bindRunCodeRegistry` in source/lib/agent-factory.ts binds policy-wrapped tools
  after definition creation. A filtered definition graph is therefore useful.
- Read-file definition is `source/tools/file/read-file.ts`, not file-system/.
  Need inspect execute signature before wrapping; AnyToolDefinition execute is
  called with params, context, SDK details.
- CommandMessage fields source/tools/types.ts: callId?, toolName?, success?,
  output, toolArgs?, id, status. Conversation events in
  source/services/conversation/conversation-events.ts: tool_started carries
  toolCallId, toolName, arguments; command_message carries message;
  noninteractive emits one `completed` with finalText.
- Plan mode doesn't block shell; not adequate containment. Public AgentRuntime
  tool resolver does not accept run_code, so simply using runtime tools
  ['read_file','run_code'] fails. Hooks are observation callbacks, not policy.
- CLI fresh profile logic source/cli.tsx honors persisted standard mode with
  --auto-approve. No useful per-tool CLI allowlist was found.

## Methodology and audit context

Loaded investigation, simplicity-architect, workflow-evolution-ledger,
workflow-evolution, implementation, verification, writing-docs, term2 skills.
Read docs/workflow-evolution.md and evidence-driven-development README.
Workflow ledger v1 only supports one pair per task and is scoped to one skill
mutation, while this study is an explicit task-local instruction trial across
model strata. Draft uses its own frozen JSON comparator; don't fabricate old
loaded-method evidence to satisfy ledger. Explain this bounded design choice.
Need final independent efficacy inspection; if candidate qualifies, also obey
fresh ordinary-use verification gate before any skill/orchestration adoption.
If none qualifies, commit benchmark/results only; do NOT install the candidate.

Earlier audit: 14 Oct 19 sessions, 760 run_code records, 24 explicit failures:
11 syntax, 4 text() helper, 3 missing path, 2 regex, 2 timeout, 1 overflow,
1 shadowed tools. These are historical motivation, NOT matched baseline.
Known distinct real partial-batch failures: session f152cc60 records 15, 68,
128 (missing paths; successful siblings retained by recovery). Historical
audit raw summary is at /tmp/qduc/term2-nodejs/tool-output/
run-code-2863558-1792459283065-d20a51.txt but /tmp is not durable; relevant facts
are recorded here and sessions can be retrieved if needed.
