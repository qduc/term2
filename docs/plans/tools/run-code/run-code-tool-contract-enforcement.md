# run_code tool contract enforcement: every scriptable tool declares its return schema

## Resume here

**Status: COMPLETE — compile-time enforcement, runtime exercise, suites and
independent verification all done; merged into `main`.**
Commit `26ac5635` on `rc-tool-schemas` (34 files), merged as `ef99e3ac`; the
worktree and branch are removed. `pnpm typecheck` is clean (0 errors, was 43 at
the enforcement checkpoint) and `pnpm exec prettier --check .` is clean;
`pnpm lint` reports 0 errors / 31 pre-existing warnings. Re-verified on `main`
after the merge.

**Goal (user's words).** `run_code` must tell the agent the input *and* output
schema of every tool available, so the agent does not misuse tools; and a tool
must expose its schema to `run_code` such that adding or changing a tool cannot
silently omit it — **the compiler fails loudly**. Method is the implementer's
choice. The work must be finished, not just designed.

Record of what was verified, in order:

1. **Runtime exercise — DONE (passed).** See "Runtime exercise evidence" below.
2. **Suites — DONE.** `pnpm test:provider-black-box`: 22 files, 202 passed,
   1 skipped, 0 failed. `source/tools/system/run-code/run-code-runtime-boundary.test.ts`:
   2 passed. `source/gateway/runtime-factory.integration.test.ts`: passed (also
   re-run as part of the full `pnpm test:integration` sweep).
   `source/cli.integration.test.ts` has 5 failures that reproduce identically at
   the branch point `ba43f2a4` with this change stashed, so they are pre-existing
   and unrelated (shell approval heuristic classification of `rm`: "command is
   YELLOW (suspicious) and no auto-approve model is configured"). Not addressed
   here.
3. **Independent verifier — DONE (passed, with a recorded caveat).** See
   "Independent verifier verdict" below.
4. **Commit and integrate — DONE.** Committed as `26ac5635`, merged into `main`
   as `ef99e3ac` with `--no-ff`, then `git worktree remove` and
   `git branch -d rc-tool-schemas` per
   `docs/agent-context.md#parallel-work-isolation`.

## Design as implemented (settled — do not re-derive)

The contract model already existed and was not altered: a script-visible value is
validated against `scriptedReturnSchema` before it crosses into the VM, and
`source/tools/scripted-return-contract.ts` states the two contract states as
*precise* and *unknown* (prose is explicitly not a contract state). What this
change adds is **enforcement that every tool a script can reach has a precise
contract**, by typing the two assembled registries as a union of two lanes:

- `ScriptedToolDefinition<TSchema, TName>` (`source/tools/types.ts`) =
  `SchemaToolDefinition` **plus required** `scriptedReturnSchema`. A scriptable
  tool cannot be registered without declaring what it returns.
- `DirectToolDefinition<TName extends ProhibitedToolName>` = `AnyToolDefinition`
  with `name` pinned to the union in `source/tools/tool-names.ts`, which is bound
  at compile time to the runtime set `RUN_CODE_PROHIBITED_TOOLS`
  (`run-code-runtime.ts`, built from a typed array). A tool cannot dodge its
  contract by claiming to be withheld under a name that is not withheld.
- `RegistryToolDefinition = AnyScriptedToolDefinition | DirectToolDefinition`,
  the element type of both registries (`source/agent.ts` root, and
  `source/services/subagents/tool-policy.ts` `buildToolDefinitions`).
- `SchemaToolDefinition`/`ToolDefinition` gained a defaulted second type
  parameter `TName extends string = string`, so a factory can pin its literal name
  (`ToolDefinition<typeof schema, 'shell'>`) without touching other call sites.
- Scope/policy wrappers in `tool-policy.ts` thread the lane: shell wrappers carry
  `TName`; `wrapReadToolWithScope`/`wrapWriteToolWithScope`/`wrapNetworkToolWithScope`/
  `wrapWriteTool` take and return `ScriptedToolDefinition<S>` (the spread
  preserves the required schema, so no casts).

**Deviation from the earlier sketch (recorded).** The registry union is
`AnyScriptedToolDefinition | DirectToolDefinition`, not
`ScriptedToolDefinition | DirectToolDefinition`. A concrete
`ScriptedToolDefinition<ZodObject<…>>` is *not* assignable to the defaulted
`ScriptedToolDefinition<ZodTypeAny, string>`: `parallelSafe` is a property whose
function parameter is checked contravariantly, so the erased target cannot accept
a concrete one. `AnyScriptedToolDefinition` is an interface extending
`AnyToolDefinition` (whose `parallelSafe` uses `never` and whose callbacks use
method syntax, which is bivariant) with a **required** `scriptedReturnSchema` —
the same erasure the model-facing lane already used. Enforcement is unchanged:
a tool without a schema still fails at the registration site.

**Boundary that stays honest.** MCP tools are appended from a runtime catalogue
after the registry (`run-code.ts`, `exposedTools`) and cannot be compile-checked;
they render as `unknown`. No schemas were faked for them.

## Contracts as implemented (scripted lane)

Rule applied per tool: read its `isScriptedToolCall(context)` branch
(`source/utils/output/bound-tool-result.ts`) — never the direct-call text path —
and describe the post-`serializeResult` value. Two conventions:

- A tool that serializes its envelope to a JSON string on every path (success
  *and* failure) gets `z.string()`; the envelope prose stays in
  `scriptedReturnShape`, which the header renders as `(guidance: …)`. This is
  where the recovery audit's memory result-shape misread comes from
  (`docs/reports/run-code-failure-recovery-audit-2026-09-13.md` at `3eb16591`, Finding 2): the
  script-visible value really is a string.
- Object envelopes use `.strict()`. Zod strips undeclared keys by default, and
  `validateScriptedReturn` delivers `parsed.data`, so a non-strict schema would
  silently delete fields the script currently receives; strict makes drift fail
  loudly instead.

| Tool | Scripted contract |
| --- | --- |
| `read_file` | union: envelope `{path,totalLines,fromLine,toLine,content,truncated,fullOutputPath?}` (strict); content-part array for image reads (text part / media-reference marker `{__term2_run_code_media_reference__}` / omission string); or a string (empty file, truncation and media-omission notices) |
| `glob` | union: `{paths,total,truncated}` (strict) or string (pre-existing, unchanged) |
| `apply_patch`, `configure_task_check_in` | `z.string()` (pre-existing, unchanged) |
| `code_context_search` | union: `{queryType:'related',path,results:[{filePath,tokens}],truncated,partial}` (strict); `{queryType:'symbol',symbol,matches:[{name,kind,line,exported,filePath}],truncated,partial}` (strict); or a string (`WARNING rg_unavailable`, `WARNING unsupported_language`, unsafe-symbol error) |
| `session_list` | union: `{sessions:[{id,shortRef,createdAt,updatedAt,firstUserMessage?,model?,provider?,messageCount}],scope,total,omitted,unavailable,charsUsed}` (strict) or `{error:{code,message,candidates?}}` (strict) |
| `session_search` | union: `{results:[{sessionId,shortRef,kind,messageIndex,snippet:{text,truncated},updatedAt}],scope,total,omitted,unavailable,skippedMessageCount,charsUsed}` (strict) or the error envelope |
| `session_read` | union: `{scope,session:{id,shortRef,createdAt,updatedAt,model?,provider?},items:[{index,kind,toolName?,text,textOffset,totalTextChars,complete,truncated?}],nextCursor?,total,matched?,omitted,skippedMessageCount,charsUsed}` (strict) or the error envelope |
| `grep`, `read_code_outline`, `create_file`, `search_replace`, `web_search`, `web_fetch`, `activate_skill`, `propose_goal`, `run_explorer`, `ask_orchestrator`, `get_subagent_result`, `get_subagent_status`, `send_message`, `cancel_run`, `get_shell_job`, `cancel_shell_job`, `monitor_shell_job`, `cancel_shell_monitor`, `memory_list`, `memory_get`, `memory_search`, `memory_retrieve`, `memory_create`, `memory_update`, `memory_delete` | `z.string()` — JSON envelope or prose text; the envelope is documented in the tool's `scriptedReturnShape` |

Notes.

- Memory: every `memory_*` tool returns `JSON.stringify(envelope)` on both paths
  (`safe()` / `boundedError()` in `source/tools/memory/memory-tools.ts`), so the
  contract is `string`. `MEMORY_SCRIPTED_RETURN_SHAPES` is retained as guidance;
  `createMemoryToolDefinitions` and `MemoryCapability.tools` are typed
  `AnyScriptedToolDefinition[]`.
- `run_subagent_async` (`createRunSubagentAsyncToolDefinition`,
  `source/tools/agent/run-subagent-async.ts`) is unregistered dead code and keeps
  its `ToolDefinition` annotation; it is not script-reachable. Registering it
  would fail typecheck until it declares a contract, which is the intended
  behaviour.
- `enter_worktree`/`exit_worktree` (`source/tools/system/worktree.ts`) are the
  direct lane: the factory's return type is `DirectToolDefinition<'enter_worktree'>`
  / `<'exit_worktree'>`, while the local definitions keep their precise
  `ToolDefinition<typeof schema, 'literal'>` type so the body keeps schema-derived
  parameter types.

## Runtime exercise evidence (step 1 — passed)

Harness (temporary; delete before commit):
`source/gateway/rc-contract-probe.integration.test.ts`. It drives the real
`run_code` path twice over — (A) two gateway root sessions
(`createProductionRuntimeFactory`, `access: read_write`) whose scripted provider
emits one `run_code` call, one with the editors surface and one with a
patch-preferring model id, and (B) a standalone `createRunCodeRuntime` whose
registry is assembled from the real tool factories (real `SessionBrowser` over
real persisted conversations, real `BackgroundShellRegistry` with a completed and
a running job, real `FileMemoryStore`s) with an auto-approving
`ToolApprovalPolicyRegistry` test seam.

Every probe is one `tools.<name>(params)` call in a try/catch; the script
classifies each outcome as `ok`, an expected error, or a contract violation
(a rejection whose message contains "violates its scripted output contract"),
and returns a verdict token the test asserts on.

Results (all three runs, 2026-10-17):

| Run | Probes | ok | Expected errors | Unexpected | Contract violations |
| --- | --- | --- | --- | --- | --- |
| A1 gateway root, editors | 32 | 28 | 4 | 0 | **0** |
| A2 gateway root, patch | 3 | 2 | 1 | 0 | **0** |
| B standalone runtime | 19 | 19 | 0 | 0 | **0** |

Distinct migrated scripted tools exercised: **33 of 33** (the full table below,
plus `memory_update`/`memory_delete` in both lanes).

What the probes returned, where it matters:

- `read_file`: text and ranged reads return the strict envelope
  `{path,totalLines,fromLine,toLine,content,truncated}` (no `fullOutputPath`
  when untruncated); an empty file returns a string; an image returns a
  content-part array; a **binary** file *rejects* (not a return value), as does a
  missing path.
- `glob`: both a match and a no-match return `{paths,total,truncated}`.
- `code_context_search`: symbol mode returns
  `{queryType,symbol,matches,truncated,partial}`; related mode on a plain-text
  file returns a string (the unsupported-language warning).
- `session_*`: real envelopes with exactly the declared keys —
  `session_list` `{sessions,scope,total,omitted,unavailable,charsUsed}`,
  `session_search` adds `skippedMessageCount`, `session_read`
  `{scope,session,items,total,omitted,skippedMessageCount,charsUsed}`; an
  unknown id returns the `{error}` envelope.
- Every `z.string()` tool returned a string, including the ones whose deps were
  stubbed (`activate_skill`, `propose_goal`, `run_explorer`,
  `ask_orchestrator`, the four shell-job tools) — the tool's own serialization
  decides string-ness, so the stub cannot fake the result.
- `memory_update`/`memory_delete` are **approval-gated**: from a gateway
  `run_code` call with no nested approval owner they refuse with "requires
  approval and is unavailable from inside a script". Their success paths were
  therefore exercised in run B with the real stores and an auto-approving
  registry, where both returned strings.

Artifacts from the run: `/tmp/rc-probe-report-editors.txt`,
`/tmp/rc-probe-report-patch.txt`, `/tmp/rc-probe-report-standalone.json`
(ephemeral; the numbers above are the record).

## Compile-time enforcement evidence (step 3 — passed)

The user's requirement is that adding or changing a tool must make the compiler
fail loudly. Tested directly by mutating a real registered tool and running
`pnpm typecheck`:

- Deleting `scriptedReturnSchema` from `createGrepToolDefinition`
  (`source/tools/file/grep.ts`) produced
  `error TS2322 ... Property 'scriptedReturnSchema' is missing in type '{ name: string; ... }'
  but required in type '{ scriptedReturnSchema: ZodType<...>; }'` at the
  definition site.
- Renaming it to a bogus property produced
  `error TS2561 ... 'scriptedReturnSchemaDISABLED' does not exist in type
  'ScriptedToolDefinition<...>'. Did you mean to write 'scriptedReturnSchema'?`

Both mutations were reverted; `git diff` confirms the two files carry only their
intended changes and `pnpm typecheck` is clean again.

## Independent verifier verdict (step 4 — passed, with a recorded caveat)

A read-only reviewer subagent, given the branch point, the diff and this doc with
instructions to treat its claims as claims, independently re-derived each
contract from the tool source and reported:

- **No concrete schema mismatch in the 33 migrated tools.** All six
  object-envelope contracts (read_file, glob, code_context_search, session_list,
  session_search, session_read) match the objects the tools actually construct,
  including optional fields; the reviewer specifically confirmed
  `session_search`'s internal `score` is stripped before output, so its absence
  from the schema is correct, and that `read_file`'s raw image part becomes the
  declared media-reference marker (or the omission string) before validation.
- **No non-string returning branch** among the 27 `z.string()` tools; it
  separated throwing branches from returned error values.
- **The compile-time guarantee holds at both designated registry builders**
  (`source/agent.ts`, `source/services/subagents/tool-policy.ts`).
- MCP tools stay an explicit unvalidated boundary; `run_subagent_async` has no
  registration reference; `run_subagent`, `ask_user` and `run_agent_workflow`
  are withheld by name, and the `ProhibitedToolName` union matches the runtime
  set exactly.

**Recorded caveat (accepted, not fixed).** `ToolRegistry` is still
`readonly AnyToolDefinition[]` and `AnyToolDefinition.scriptedReturnSchema` is
still optional, and `validateScriptedReturn` returns an unvalidated value when a
schema is absent. So the enforcement is builder-local: the two builders that
assemble the root and subagent registries cannot register a schema-less
non-prohibited tool, but some *other* caller that constructs a bare
`ToolRegistry` by hand could. The reviewer found no first-party registration
exploiting that, and closing it would mean tightening the shared
`AnyToolDefinition`/`ToolRegistry` seam that the erased model-facing lane
deliberately relies on — out of scope for this change.

The verifier did not run compilation; the negative-compilation probes in the
section above were run directly by the implementer, so the two halves are
independent evidence.

## Verification (remaining)

1. Commit on the branch; integrate and clean up per
   `docs/agent-context.md#parallel-work-isolation`.

## Ruled out (do not revisit)

(a) Requiring the deprecated `scriptedReturnShape` prose — it is guidance, not a
contract state. (b) "Every scriptable tool declares a shape" as the invariant — it
forces fiction where `unknown` is the honest state. (c) Closing the tool-name
space into one union so exposure is type-derivable — the registry is composed
conditionally from capabilities/settings/MCP, so a static mapped type cannot be
the registry; cost is repo-wide with no gain over the union above. (d)
`keyof typeof` over a `Record<string, string>` map — vacuous, since `keyof` is
then `string`.
