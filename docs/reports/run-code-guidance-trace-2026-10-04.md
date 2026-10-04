# Current create_file guidance trace

## Conclusion

No demonstrably obsolete current editing instruction was found in the inspected
prompt and registry paths. Keep the valid alternate-model editor branch; do not
remove `create_file` globally merely because it is unavailable on a patch-only
surface. This trace does not establish why four historical sessions repeated
the unavailable-tool request or identify the prompt actually served to them.

## Evidence

- `getScriptPrimaryToolsAddendum` in `source/prompts/tool-surface-guidance.ts`
  routes `patch` to `apply_patch` with `*** Add File:`, `editors` to
  `search_replace`/`create_file`, and `none` to no file editors. It already
  recommends `inputs` for payloads containing quotes, backticks or interpolation.
- `getAgentDefinition` in `source/agent.ts` derives `editorSurface` from write
  authority and `usesPatchEditingSurface`. Both lite and full registry branches
  use the same selection to register patch or legacy editor tools.
- `source/prompts/prompt-constructor.test.ts` pins all three guidance arms,
  including absence of legacy tool names on the patch arm.
- `createUnknownToolHints` in `run-code-runtime.ts` gives unavailable
  `create_file`/`search_replace` calls the correction: use `apply_patch` and
  `*** Add File:`. The reverse hint is conditional on a legacy editor registry.
- `shell-auto-approval.ts` mentions all supported mutating editors as approval
  policy examples, not as a statement that each is available in every session.
- The preceding session's Markdown searches of repository and installed skills
  found no `create_file` matches. That negative search is limited to those
  inspected skill trees, not all historical or user-provided instructions.

## Validation and disposition

The executed prompt test run passed all 103 tests in 13 files. No prompt change
is warranted by this evidence; deleting the legacy arm would contradict the
current registry. Historical replay or model intervention would require a
separate experiment, not an inferred cleanup. The paired local composition
experiment is recorded separately in
`run-code-composition-experiment-2026-10-04.md`.
