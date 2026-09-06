# Report & Retrospective: run_code Contract & Boundary Repair

**Worktree**: `/home/qduc/term2/.worktrees/rc-contract-repair`  
**Branch**: `rc-contract-repair`  
**Commits**:
- `5d83db4f39f7922700cdebb0fbc572d9ca74d8a9`: Initial contract repair across transport budgeting, canonical schema provider parity, and scripted operational rejections.
- `20fcd401098195934ea8e4c08850399bd264d472`: Adversarial review follow-up (removal of generic field shrinking, UTF-8 envelope byte budgeting, and code-context return declaration alignment).

---

## 1. Executive Summary

This report records the root cause analysis, systemic architectural gaps, implementation resolutions, adversarial review closure, and verification results for three contract and boundary defects in `run_code` nested execution:

1. **Oversized structured results**: Truncation corrupted JSON strings in `#serializeResult()`, and `read_file` budgeted content before metadata/escaping. Generic field shrinking was attempted and rejected; the final repair enforces full UTF-8 byte budgeting for `read_file` envelopes and artifact-spool rejection with completed-effects disclosure for oversized generic objects.
2. **Provider parity under strict JSON schema substitution**: Tool parameter schemas converted to strict JSON schemas for OpenAI caused `run_code` to bypass pre-dispatch validation and fulfill with late diagnostic strings, whereas OpenRouter rejected early. Preserving `canonicalParameters` across provider transformations restored strict parity.
3. **Scripted operational failures**: Direct tool implementations returned user-facing `"Error: ..."` strings instead of throwing, causing scripted promises to resolve successfully. Scripted calls now reject with explicit errors for operational failures, preserving `try/catch` and `Promise.allSettled` semantics.

---

## 2. Defect Analysis, Implementations & Review Closure

### Defect 1: Oversized Structured Results & Transport Budgeting

#### Root Cause
- In `source/tools/system/run-code/run-code.ts`, `#serializeResult()` sliced any result whose JSON representation exceeded `RUN_CODE_LIMITS.maxResultChars` (100,000 characters) via `truncate(encoded, limit)`. This sliced mid-JSON, producing corrupted strings like `"[truncated: result exceeded 100000 characters]"` that broke `JSON.parse` across the worker VM boundary.
- In `source/tools/file/read-file.ts`, content was bounded at 100,000 bytes *before* adding envelope metadata (`path`, `totalLines`, `fromLine`, `toLine`, `truncated`) and JSON character escaping, causing the resulting envelope to reliably exceed the limit (~100,050 chars) and trigger string truncation.

#### Review Finding & Follow-Up (SEV-3)
- **Attempted & Rejected**: The initial fix attempted generic structured-field shrinking in `#serializeResult()` by inspecting property names (e.g. `content`) and binary-searching a truncated prefix. Adversarial review (`/tmp/rc-independent-review.md`) demonstrated that this corrupted internal consistency (e.g. `{ content, contentLength: 100000, truncated: false }` returned truncated content while claiming `truncated: false`) without a truncation marker or retrieval path.
- **UTF-16 vs UTF-8 Byte Budget (SEV-3)**: The initial fix checked `.length <= maxResultBytes` on the JSON string. For Unicode/CJK text, character count diverged sharply from UTF-8 byte count, allowing payloads to bypass `resolveResultMaxBytesForCall` and fail at the sandbox host boundary (`262,144` bytes).

#### Final Resolution
- **Removed generic field shrinking**: In `source/tools/system/run-code/run-code.ts`, generic structured objects within limits pass intact. Oversized generic objects are spooled to temporary disk artifacts via `saveOutputArtifact(encoded, { filenamePrefix: 'tool-overflow' })` and returned as worker failure `{ ok: false, error }`, rejecting the script promise with the artifact path, byte count, and an explicit warning that tool side effects already completed and must not be blindly replayed.
- **Envelope byte budgeting**: In `source/tools/file/read-file.ts`, scripted calls compute the envelope budget strictly in UTF-8 bytes using `Buffer.byteLength(JSON.stringify(envelope), 'utf8')`. When content exceeds the budget, raw content is saved to an artifact, `truncated: true` and `fullOutputPath` are attached, and binary search determines the exact content slice without splitting UTF-16 surrogate pairs (`/[\uD800-\uDBFF]$/`).
- **Too-small budget guards**: If the budget cannot accommodate `fullOutputPath`, it is omitted; if the budget is smaller than the empty minimal envelope, an explicit `Error` is thrown.
- **Reviewer Closure**: Re-review (`/tmp/rc-independent-rereview.md`) verified that generic shrinking was removed, all envelope checks measure UTF-8 bytes, surrogate pairs are preserved, and artifact paths are safely exposed.

---

### Defect 2: Provider Parity Under Strict JSON Schema Substitution

#### Root Cause
- Providers with strict schema requirements (e.g. OpenAI) had their tool `parameters` substituted with strict JSON schema objects in `buildAgentTools` (`source/lib/agent-factory.ts`) and `SubagentToolFactory.buildAgentTools` (`source/services/subagents/tool-policy.ts`).
- When `run_code` inspected nested tool calls in `#prepare()`, it checked `isZodToolParameterSchema(tool.parameters)`. Because `tool.parameters` was now a raw JSON schema object, `run_code` skipped early schema validation.
- The unvalidated invocation fell through to `invoke()`, where the outer `wrapToolInvoke` caught the schema mismatch and returned a diagnostic string (`"Tool input did not match schema: ..."`).
- Consequently, an identical invalid call fulfilled with an error string under OpenAI, but rejected early in `#prepare()` with a compact signature under OpenRouter (where `tool.parameters` remained a Zod schema).

#### Final Resolution
- Extended `SchemaToolDefinition` and `AnyToolDefinition` in `source/tools/types.ts` with optional `canonicalParameters?: ZodTypeAny`.
- In `buildAgentTools` (`agent-factory.ts`) and `SubagentToolFactory.buildAgentTools` (`tool-policy.ts`), preserved the original Zod schema in `canonicalParameters` across strict JSON schema conversions.
- In `source/tools/system/run-code/run-code.ts` (`#prepare()` and `#describeTool()`) and `source/tools/system/run-code/tools-header.ts` (`renderCompactSignature`), updated schema inspection to prioritize `tool.canonicalParameters ?? tool.parameters`.
- **Reviewer Closure**: Re-review confirmed that provider substitution preserves canonical schemas, and both OpenAI and OpenRouter reject invalid nested invocations before approval/dispatch with identical compact signatures.

---

### Defect 3: Scripted Operational Failures Rejection

#### Root Cause
- `source/tools/file/read-file.ts` caught operational filesystem errors (`ENOENT`, `EISDIR`, `EACCES`, `outside workspace`) and binary file detection, returning formatted strings (e.g. `"Error: File not found: ..."`).
- In direct conversation mode, formatted strings provide user-friendly feedback. But in `run_code`, returning a string fulfilled the JavaScript Promise, preventing scripts from catching errors via standard `try { await tools.read_file(...) } catch (err)` or sorting outcomes via `Promise.allSettled()`.

#### Review Finding & Follow-Up (SEV-3)
- **Declaration Contradiction**: While `read-file.ts` and `code-context.ts` were updated to throw on `isScriptedToolCall(context)`, the declared `scriptedReturnShape` in `code-context.ts` explicitly advertised returning `"Error: ..."` strings on failure. This contradiction was rendered verbatim into the model-facing `tools-header.ts`.

#### Final Resolution
- In `source/tools/file/read-file.ts`, `isScriptedToolCall(context)` causes operational failures (`ENOENT`, `EISDIR`, `EACCES`, `outside workspace`) and binary detection to throw explicit `Error` instances. Direct calls continue to return formatted strings.
- In `source/tools/file/code-context.ts`, `read_code_outline` and `code_context_search` rethrow filesystem operational errors when `isScriptedToolCall(context)` is true.
- Updated `scriptedReturnShape` declarations for `read_code_outline` and `code_context_search` in `source/tools/file/code-context.ts` to document that operational failures reject and should be handled via `try/catch` or `Promise.allSettled`.
- **Reviewer Closure**: Re-review verified that declarations match runtime behavior, header generation accurately reflects rejection contracts, and direct user/model invocations retain human-friendly formatting.

---

## 3. Systematic Bug Retrospective (Level 3 Checklist)

Workthrough across the 11 systemic checklist items:

1. **Representability**:
   - *Problem*: `ToolDefinition.parameters` conflated the runtime validation engine (Zod) with wire-format provider schemas (JSON Schema).
   - *Improvement*: Introducing `canonicalParameters?: ZodTypeAny` allows definitions to carry runtime validation capability independently of downstream wire transformations.
2. **Single Source of Truth**:
   - *Problem*: Parameter validation rules were duplicated between provider wire formatting and local execution wrappers.
   - *Improvement*: `canonicalParameters` serves as the single source of truth for runtime validation and signature generation across all providers.
3. **Boundary Contract**:
   - *Problem*: The boundary between direct tool dispatch (UI/string-oriented) and scripted execution (programmatic Promise resolution/rejection) lacked distinct operational error contracts.
   - *Improvement*: `isScriptedToolCall(context)` formalizes the boundary condition: programmatic execution expects exceptions for abnormal termination; interactive chat expects descriptive diagnostic strings.
4. **Implicit Coupling**:
   - *Problem*: `serializeResult` assumed string output could be safely truncated without coupling to the content encoding or envelope schema.
   - *Improvement*: Envelopes are now sized at creation in the tool owner (`read_file`), and transport limits reject atomically rather than performing ad-hoc string mutations.
5. **Wrong Assumption**:
   - *Problem*: Assumed that JavaScript string character `.length` equalled serialized UTF-8 byte count, and assumed tool results with a `content` field could have that field safely truncated in isolation.
   - *Improvement*: Replaced character-length budgeting with `Buffer.byteLength(..., 'utf8')` and eliminated heuristic property shrinking.
6. **Detection Gap**:
   - *Problem*: Existing tests checked interactive tool strings and mocked provider adapters, but did not assert identical rejection semantics across simulated provider configurations.
   - *Improvement*: Added multi-provider parity tests in `agent-factory.test.ts` and `run-code.test.ts` exercising OpenAI strict schema conversion and OpenRouter Zod retention side-by-side.
7. **Automation Gap**:
   - *Problem*: Type systems permitted `parameters` to be either Zod or JSON Schema without tracking whether validation was runnable.
   - *Improvement*: Explicit type narrowing via `isZodToolParameterSchema` and canonical schema fallback.
8. **Sibling Paths**:
   - *Problem*: `read_code_outline` and `code_context_search` in `code-context.ts` shared the operational catch pattern with `read-file.ts`.
   - *Audit*: Audited sibling tools; aligned both code-context tools and their declared return shapes. Domain tools (e.g. `session-browser-tools.ts`) that return structured result envelopes without throwing were audited and confirmed intentional.
9. **Knowledge Gap**:
   - *Problem*: The contract that scripted tools must reject rather than return error strings was documented informally in prompt text but not formalized in tool definitions.
   - *Improvement*: Documented guard policies in `docs/plans/guard-ledger.md` and updated `scriptedReturnShape` contracts.
10. **Observability**:
    - *Problem*: Truncated strings silently failed in the VM worker without indicating what was lost or where complete data could be found.
    - *Improvement*: Generic overflows now spool full content to disk and reject with the specific artifact path and completed-effects disclosure.
11. **Origin**:
    - *Classification*: Latent defect in `run_code` transport design and provider schema conversion. The assumptions had been present since the initial implementation of nested execution and strict schema support.

---

## 4. Retrospective Summaries

### Retro: Oversized Structured Result JSON Corruption
```
Preventable:      yes — transport serialization must not slice arbitrary JSON structures.
Bug:              serializeResult sliced strings > 100k chars; read_file exceeded 100k chars due to metadata.
Origin:           latent in run_code serialization and read_file budgeting.
Root cause:       truncate() performed character slicing on serialized JSON without syntax awareness.
System weakness:  No boundary assertion ensuring serialized VM results remained valid JSON.
Fixed:            UTF-8 envelope budgeting in read_file; artifact spooling and error rejection in serializeResult.
Siblings:         read_file and run_code transport checked; media markers preserved.
Hardened:         Guard ledger updated; surrogate pair and minimum envelope safety checks added.
Later:            None.
```

### Retro: Provider Parity Under Strict Schema Substitution
```
Preventable:      yes — tool schema transformation should not degrade runtime execution capabilities.
Bug:              OpenAI strict schema substitution bypassed run_code parameter validation.
Origin:           latent in strict JSON schema introduction in agent-factory.
Root cause:       parameters was overwritten with a plain JSON object lacking Zod parse methods.
System weakness:  Dual-purpose parameters field used for both API wire export and local runtime validation.
Fixed:            canonicalParameters preserved on SchemaToolDefinition across transformations.
Siblings:         SubagentToolFactory and main agent-factory updated.
Hardened:         agent-factory.test.ts verifies canonical schema retention for strict and non-strict providers.
Later:            None.
```

### Retro: Scripted Operational Failure String Fulfillment
```
Preventable:      yes — programmatic execution requires standard exception handling semantics.
Bug:              read_file and code_context returned "Error: ..." strings on ENOENT/EISDIR.
Origin:           latent since adaptation of CLI tools for scripted execution.
Root cause:       Tools caught filesystem exceptions to produce human-readable strings for chat UI.
System weakness:  Shared tool handler did not differentiate between human UI and scripted VM callers.
Fixed:            isScriptedToolCall(context) branches throw explicit Errors for operational failures.
Siblings:         read_file, read_code_outline, and code_context_search updated; return shapes aligned.
Hardened:         read-file.test.ts and code-context.test.ts test scripted rejection vs direct string output.
Later:            None.
```

---

## 5. Verification & Test Evidence

### Independent Review Verdicts
- **Initial Review (`/tmp/rc-independent-review.md` @ `5d83db4f`)**: `approve-with-fixes` (3 SEV-3 medium findings: generic field shrinking, UTF-16 byte accounting, return declaration contradiction).
- **Follow-up Review (`/tmp/rc-independent-rereview.md` @ `20fcd401`)**: `no material issues found` (all 3 findings closed, 0 new findings).

### Test Suite Execution
- **Targeted Tool Suite** (`TMPDIR=/tmp`): **218 / 218 passed**
  - `source/tools/file/read-file.test.ts`: 30 passed
  - `source/tools/system/run-code/run-code.test.ts`: 90 passed
  - `source/tools/file/code-context.test.ts`: 37 passed
  - `source/lib/agent-factory.test.ts`: 47 passed
  - `source/tools/system/run-code/scripted-e2e.test.ts`: 4 passed
  - `source/tools/session-browser/session-browser-tools.test.ts`: 10 passed
- **Broad Parent Gates**:
  - Full suite (`TMPDIR=/tmp pnpm test`): **8097 passed, 3 expected failures, 2 skipped** (161.50s).
  - Provider black-box gate (`pnpm test:provider-black-box`): **177 passed, 1 skipped** (85.78s).
  - Combined gate run: **exit 0 in 254.23s**.
  - Static analysis: `pnpm typecheck` passed (0 errors); `git diff --check` passed.
- **Environmental Diagnosis**:
  - Default nested worktree `TMPDIR` paths triggered 5 pre-existing outside-workspace and nested-approval acceptance test failures sensitive to directory prefixes; all 94 focused tests and the full suite passed cleanly with `TMPDIR=/tmp`.
  - An initial provider gate run encountered a 15s socket timeout; isolated re-run completed in 12.67s, and the full subsequent provider black-box gate passed completely.

---

## 6. Retro Residuals & Guidance

1. **UTF-8 Byte Length vs Character Length in Tool Envelopes**:
   - Any tool budgeting serialized output for transport or context inclusion must measure UTF-8 bytes via `Buffer.byteLength(JSON.stringify(envelope), 'utf8')`, never string `.length`. String character counts fail silently on Unicode and CJK content.
2. **Preserving Runtime Capabilities on Transformed Tool Definitions**:
   - When tools are wrapped or transformed for external wire representations (such as strict JSON schema formatting for OpenAI), operational metadata required by local execution engines must be retained on designated canonical fields (`canonicalParameters`).
3. **Programmatic Contract Integrity**:
   - Tools shared between chat UI and scripted execution environments must strictly bifurcate operational errors: human-facing modes return diagnostic prose; programmatic callers (`isScriptedToolCall`) must receive promise rejections. Never return formatted error strings to an automated execution harness.
