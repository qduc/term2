# Field test: `run_code` as the primary tool path

Status: **Merged to `main` (`2ab57206`, 2026-09-04). Never exercised by a real
model.** Everything verified so far is structural — tests prove no tool was
deleted and no prompt contradicts the code. Nothing proves a model can *work*
this way.

You are picking this up cold. Read this before designing the test, and treat
each concern below as a hypothesis to confirm or kill, not a warning to respect.

## What changed, in one paragraph

The model's direct tool list went from 39 definitions to 14. A tool is directly
callable only if a script structurally cannot reach it (`shell`, `bash`,
`ask_user`, `run_subagent`, `run_agent_workflow`, `session_rollover`,
`ask_mentor`, `run_code`) or if its approval depends on its parameters
(`read_file`, `grep`, `glob`, `create_file`, `search_replace`,
`read_code_outline`, `code_context_search`, `apply_patch` on gpt-5 models) — that
second group is reachable both ways. The other 25 are reachable *only* as
`tools.<name>(params)` inside a `run_code` script. Separately, a script's
**return value** is now the result the model receives; `console.log` became a
debug trace, suppressed on success unless `include_console: true`, included on
failure.

Read `source/tools/system/run-code/run-code.ts` and
`source/lib/agent-factory.ts` (the `isDirectlyCallable` filter at the end of
`buildAgentTools`) before testing. `docs/plans/sandboxed-code-host.md` covers the
host underneath.

## How to observe

Use the `provider-traffic` skill to read what was actually sent and returned;
the model-facing tool list and every `run_code` argument are in those artifacts.
`debugging-logs` locates them. Do not infer behaviour from the rendered
conversation alone — the interesting failures are in what the model *tried* to
call.

## Concerns, most likely to bite first

### 1. The model does not return a value

**The single highest risk.** Every model has years of prior exposure to
"print your results", and we just inverted that. If it writes a script ending in
`console.log(result)` with no `return`, it gets back:

> `Script returned no result. Return a value from the script to send it to the model.`

and has to retry, having spent a full script execution.

Measure the rate of that message across a real session. A low rate means the
description works. A high rate means the description is losing to the model's
prior, and the fix is prompt wording, not code. Check whether it self-corrects
on the second attempt or repeats the mistake — a model that never learns from
that message is a much worse result than one that recovers.

### 2. Script-only tools are never discovered

25 tools appear in the header as **names only**. The model must either infer the
parameters or call `tools.describe(name)` for the schema.

Three distinct failure modes, and they need distinguishing:
- It calls `describe` and proceeds — working as designed.
- It guesses parameters and gets a Zod validation error — costs a round trip but
  is self-correcting. Count how often the guess is right.
- It never uses those tools at all, and silently does without memory, session
  search, or web search because it cannot see how to call them. **This is the
  dangerous one**, because nothing errors. Compare against a baseline session on
  the pre-change surface: if memory and session tools stop being used, the
  namespace is not discoverable enough.

### 3. It calls tools that are no longer in the payload

Prompts were rewritten and a guard test now fails if a fragment names a
script-only tool directly, but the model's own prior may still produce e.g. a
bare `web_search` call. Look for tool calls the provider rejects or that arrive
as hallucinated names. Any occurrence points at a prompt fragment we missed or
at a model prior strong enough to need explicit correction.

### 4. Over-scripting trivial work

Reading one file is now `run_code` with a worker spawn, a vm context, and a
script the model had to write — versus one direct `read_file` call. Note that
`read_file` is *also* still direct, so the model has a choice; the question is
which it picks. Measure latency and token cost for single-tool turns against the
baseline. If it wraps every one-shot read in a script, we have made the common
case worse to improve the rare one.

### 5. Under-scripting — the loop advantage is never taken

The mirror image, and the one that would make this change pointless. The
justification for the whole design is fan-out: read 50 files, grep across a tree,
aggregate without putting intermediates in context. If the model keeps issuing
serial direct `read_file` calls because that is what it has always done, we paid
the discovery cost for nothing. Count multi-call scripts versus serial direct
calls on tasks that obviously want a loop.

### 6. Approval dead-ends and whether it recovers

A gated call inside a script (`create_file` outside the workspace, say) is
refused with advice to call it directly. That advice is now conditional on the
tool actually being directly callable. Verify the model follows it rather than
retrying the same script, and that the refusal text is comprehensible enough to
act on. A retry loop here burns a script execution per attempt.

### 7. Failure diagnosis with the trace

On failure the model gets the error plus the console trace. Check that this is
enough to fix a broken script: does it debug from the trace, or rewrite blindly?
This is the case where suppressing console on success has a cost — a script that
succeeds but does the *wrong thing* returns a clean value with no evidence of how
it got there. Watch for silently wrong results, not just errors.

### 8. Truncation of large returns

The final result is clipped at 30,000 characters, with the answer assembled
before any trace so noise cannot displace it. A 50-file fan-out returning full
contents will still hit the cap. Does the model return concise aggregates, or
does it return everything and lose the tail? There is no spooling or retrieval
path for a large return value — if this bites often, that absence is the finding.

### 9. JavaScript competence inside the sandbox

No timers (`setTimeout` is absent — this surprised the implementer, so it will
surprise a model), no `require`, no `eval`, no filesystem, no network. Only
`tools.*` and `console`. Watch for scripts that reach for any of those. Also
watch for genuine JS errors: this is now the model's primary interface, so its
ability to write correct async JavaScript on the first try is load-bearing in a
way it was not before.

### 10. Parallelism

`Promise.all` over `tools.*` calls works, bounded at 8 concurrent, but only for
tools declaring `parallelSafe`; others take a serial lane of one. Does the model
use concurrency at all? Does it try, and get serialized without understanding
why? The call budget is 200 per script.

### 11. Provider prompt-cache behaviour

The tool list is part of the request, so it changed shape. Confirm tool ordering
and identity are stable turn-to-turn — any per-turn variation invalidates the
cache on every request and would show up as a cost regression rather than a
correctness one. This is worth checking early because it is cheap to check and
expensive to miss.

## What would justify reverting

Be willing to conclude this was wrong. Concrete triggers:

- Tasks that succeeded on the old surface now fail, and the cause is the surface
  rather than an incidental bug.
- Capability silently disappears — script-only tools stop being used and the
  model does not notice it is missing them (concern 2).
- Cost or latency gets worse on ordinary single-tool turns without a
  corresponding win on fan-out.

The change is one merge commit (`2ab57206`) plus the host merge before it
(`ab5938cb`), so reverting the surface reduction without losing the shared host
is straightforward.

## Deliberately open, not defects

- `canRequireApproval` is hand-maintained metadata on tool definitions. A new
  parameter-dependent tool that forgets the flag is refused inside scripts and
  absent from the direct set. A test catches the class today; a future tool
  could still slip if the test's assumptions drift.
- Profiles without `run_code` (any profile without the `shell` capability) skip
  the filter entirely and keep the full 38-tool direct surface. Intended: the
  reduced surface is only offered when the script path exists. Test at least one
  no-shell profile to confirm it still behaves.
- The vm context is a realm-isolation seam, **not** an OS boundary. Do not treat
  a passing field test as evidence about hostile code.
