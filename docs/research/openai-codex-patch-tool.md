# OpenAI Codex `apply_patch` tool

Scope: upstream `openai/codex` `main` at commit [`8d32abcd`](https://github.com/openai/codex/tree/8d32abcd017d06511b46050cff9dbba8738fc2fa). Sources below are repository source, tests, and in-repo prompt/grammar files; links are pinned to that commit.

## Summary

The current native tool is a Responses-style freeform custom tool named `apply_patch`, not a JSON function. Codex registers it only when the selected model advertises an `apply_patch_tool_type` and a turn has an environment; multi-environment turns add an optional environment header ([tool registration](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/spec_plan.rs#L1239-L1242), [model metadata](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/models-manager/models.json#L4-L9)).

The handler parses and filesystem-verifies the complete patch before execution. It then applies the verified action through the shared approval/sandbox orchestrator. A legacy compatibility path also detects a narrowly defined `exec_command` shell/heredoc form and routes it through the same verified apply path ([native handler](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch.rs#L368-L456), [exec interception](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L369-L390)).

## Schema and model-facing description

`create_apply_patch_freeform_tool()` emits:

- name: `apply_patch`
- description: “The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.”
- format: `{ type: "grammar", syntax: "lark", definition: ... }`

The exact definition and description are asserted by unit tests ([schema constructor](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L5-L27), [schema tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch_spec_tests.rs#L4-L36)). The model prompt reinforces that the tool is freeform, must be called `apply_patch` (not `applypatch` or `apply-patch`), and must not be wrapped in JSON ([prompt guidance](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/gpt_5_2_prompt.md#L113-L120)).

## Patch format

The Lark contract is:

```text
*** Begin Patch
<one or more file operations>
*** End Patch
```

Operations are `*** Add File: <path>` followed by one or more `+` lines; `*** Delete File: <path>`; or `*** Update File: <path>`, optionally followed immediately by `*** Move to: <new path>`. Updates contain one or more `@@`/`@@ <context>` chunks with space-prefixed context, `-` removals, and `+` additions; `*** End of File` is optional ([grammar](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/assets/tools/apply_patch.lark#L1-L19), [model example and operation descriptions](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/gpt_5_2_prompt.md#L254-L289)).

The parser trims the outer text and, in the current default lenient mode, also accepts a shell heredoc wrapper such as `<<'EOF' ... EOF`; it still requires valid begin/end markers inside the wrapper. The parser documents this compatibility behavior as needed for known `local_shell`/GPT-4.1 output ([parser mode](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/parser.rs#L145-L210), [lenient boundary handling](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/parser.rs#L225-L273)).

For multi-environment turns the generated grammar permits `*** Environment ID: <id>` after `*** Begin Patch`; the streaming parser rejects an empty or repeated environment ID ([environment grammar injection](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9-L17), [streaming state validation](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/streaming_parser.rs#L84-L105)).

## Parsing and validation

The native handler accepts only a `ToolPayload::Custom` string, calls `parse_patch`, selects the requested environment, then calls `verify_apply_patch_args_with_mode` against that environment’s filesystem and sandbox context ([handler pipeline](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch.rs#L385-L419)). Verification resolves relative paths against the effective cwd, rejects duplicate resolved targets, reads delete targets, and derives updated contents by matching the requested old/context lines before creating an `ApplyPatchAction` ([verified action construction](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/invocation.rs#L200-L295), [line matching and replacement calculation](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/file_update.rs#L24-L82)).

The streaming parser is stateful: it emits completed hunk snapshots while input deltas arrive, requires a final `*** End Patch`, and rejects malformed headers/lines, empty update hunks, and content after the end marker ([streaming parser](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/streaming_parser.rs#L21-L46), [state machine](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/streaming_parser.rs#L53-L81), [completion/error rules](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/streaming_parser.rs#L154-L185)).

The shell compatibility parser recognizes direct `apply_patch`/`applypatch` calls and only whole-script heredoc forms equivalent to `apply_patch <<'EOF' ... EOF` or `cd <path> && apply_patch <<'EOF' ... EOF`. It uses Tree-sitter anchors to reject extra commands, pipes, `||`, extra arguments, and other ambiguous scripts ([invocation classification](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/invocation.rs#L28-L138), [strict shell query](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/invocation.rs#L297-L447)). A raw patch body without an explicit invocation is rejected with guidance to rerun as `["apply_patch", "<patch>"]` ([implicit-invocation guard](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/invocation.rs#L158-L187), [error text](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/lib.rs#L98-L115)).

## Application, approvals, and errors

Before writing, Codex performs a safety assessment. Empty patches are rejected; targets must be writable under the effective policy (including move destinations); otherwise the action is auto-approved only when the relevant sandbox protection is available, asked of the user, or rejected according to the approval policy ([safety assessment](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/safety.rs#L19-L98), [action preparation](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/apply_patch.rs#L22-L61)).

The execution path begins a patch event, builds an `ApplyPatchRequest`, and runs `ApplyPatchRuntime` through `ToolOrchestrator` ([verified execution](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch.rs#L558-L615)). The runtime calls `apply_patch_with_options` on the selected environment filesystem, optionally preserves line endings, supplies sandbox context, records stdout/stderr, and classifies sandbox denials ([runtime](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/runtimes/apply_patch.rs#L155-L237)).

Application is sequential per hunk. Add writes file contents (creating missing parents), delete removes only non-directories, update computes new contents then writes them, and move writes the destination before removing the original. A completion summary is emitted as `A`, `M`, and `D` paths ([filesystem application](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/lib.rs#L468-L725), [summary](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/lib.rs#L860-L877)). The implementation tracks a committed delta, including a possibly inexact prefix if a write/remove fails; the tool-event layer preserves that prefix for turn-diff reporting even when the visible tool result is a failure ([failure/delta model](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/lib.rs#L245-L335), [failure mapping](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/events.rs#L400-L455)).

Parse and verification failures are returned to the model as `FunctionCallError::RespondToModel` with `apply_patch verification failed: ...`; unsupported payloads, unavailable environments, invalid shell input, and non-`apply_patch` payloads have separate messages ([handler error mapping](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/handlers/apply_patch.rs#L385-L455)). Runtime and approval failures are likewise converted to model-visible output, including normalized `patch rejected by user` and sandbox output ([tool-event error mapping](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/events.rs#L400-L459)).

## Retries and test evidence

There are three local retry mechanisms, none of which is a model re-generation loop:

1. When an update’s old-line pattern ends with the empty newline sentinel, replacement matching retries without that sentinel if the first search fails ([replacement fallback](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/file_update.rs#L133-L170)).
2. A write that fails with `NotFound` creates missing parent directories and retries the write once ([parent-directory retry](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/lib.rs#L801-L857)).
3. The shared orchestrator may make one escalated sandbox attempt after a sandbox denial, subject to approval policy; `ApplyPatchRuntime` opts into escalation ([runtime policy](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/runtimes/apply_patch.rs#L116-L152), [orchestrator retry](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/orchestrator.rs#L305-L338), [retry approval and second attempt](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/src/tools/orchestrator.rs#L362-L487)).

The tests cover schema exactness, parser streaming and shell restrictions, multiple chunks/operations, moves, line endings, duplicate paths, missing context/files, empty patches, path traversal, symlink behavior, approval, streaming progress, and aggregate turn diffs ([invocation tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/apply-patch/src/invocation.rs#L552-L785), [CLI integration tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/tests/suite/apply_patch_cli.rs#L493-L560), [error and safety integration tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/tests/suite/apply_patch_cli.rs#L689-L880), [partial-application and streaming tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/tests/suite/apply_patch_cli.rs#L1312-L1366), [aggregation tests](https://github.com/openai/codex/blob/8d32abcd017d06511b46050cff9dbba8738fc2fa/codex-rs/core/tests/suite/apply_patch_cli.rs#L2274-L2460)).

