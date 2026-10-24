# Bare/Pair profile identity display verification

## Scope and revisions

- Task: `2026-10-24-bare-footer-label`; medium-risk display bug.
- Base source: `b0ea85208337b27e9b22d98ca3e788badf8494aa`.
- Fixed source: `269728e3a17a7699dbcaafab49c136bb15892f3f`.
- Fixed tree: `1e303aa12d8aff35fb887fc6aec07351a59f02df`.
- Isolated branch: `codex/bare-footer-20261024`, worktree
  `.worktrees/codex-bare-footer-20261024`, with its own frozen-lockfile pnpm install.
- Linux x64, Node `v24.19.0`, pnpm `11.7.0`; test commands set `NODE_ENV=test`.
  No paid model calls, network providers, agents, or terminal tabs were launched.
  Main and other worktrees were not edited or integrated.

## Cause and fix

The registry, shared labels helper, footer, and banner independently encoded
built-in profile names. Bare and Pair were missing from the footer/banner maps.
Both consumers fell back to Standard; the footer then deliberately hid Standard.
The active setting itself was correct.

`getProfileLabel` now derives lowercase names from `builtinProfileRegistry`, using
the same `ProfileDefinition.name` metadata as the profile picker. It retains its
unknown-ID fallback. Registry presentation abbreviations (`STD`, `ORCH`) are not
used because they would change existing labels. The footer applies title casing
and hides Standard; the banner applies uppercase. Both independent UI maps and
the shared helper's duplicate switch were deleted.

Mentor retains the existing Standard base badge plus one Mentor badge and its
mentor-model path. Bare/Pair were added to the theme's badge style contract using
the existing Standard swatch (including high-contrast and no-colour variants).
Those entries select styles, not profile identities. No skin layouts, approval
policy, settings persistence, or profile composition changed.

## Observable before/after evidence

The temporary probe loaded each active profile from a real temporary
`settings.json` through the real `SettingsService`. It rendered the real
`StatusBar` and `Banner` with Ink through `renderInAct`; settings transitions used
real `settings.set` notifications without remounting. No settings hook, profile
label, skin component, or provider registry was mocked.

The matrix enumerated `builtinProfiles`, not a hand-maintained profile list:

- Every built-in in the classic footer and banner at 40, 80, and 120 columns.
- Footer transitions Standard → Bare → Pair → Lite → Standard at all three widths.
- Banner transitions Standard → Bare → Pair → Mentor → Standard.
- Bare/Pair footers and Bare/Pair/Mentor banners in rail, cards, ledger, and zen
  at 80 columns.
- Existing profile title casing, hidden footer Standard, visible classic banner
  Standard, single Mentor badge, provider/sandbox controls, footer line widths,
  registry-name parity, and unknown/custom-ID fallback.

With the **same final 56-case probe**, unchanged base source produced **32 passes
and 24 expected failures**: missing Bare/Pair footer identities (six cases),
footer transitions (three), other-skin footers (four), other-skin banners (four),
banner transition (one), and Bare/Pair classic banners (six). Fixed source
produced **56 passes**, both before and after its source commit.

Representative real rendered text (leading blank layout rows omitted):

```text
                       Base                           Fixed
Bare footer:           Codex/gpt-5 │ Sandboxed         Bare │ Codex/gpt-5 │ Sandboxed
Pair footer:           Codex/gpt-5 │ Sandboxed         Pair │ Codex/gpt-5 │ Sandboxed
Standard footer:       Codex/gpt-5 │ Sandboxed         Codex/gpt-5 │ Sandboxed
Bare classic banner:   ▌ term²  STANDARD  v0.36.0       ▌ term²  BARE  v0.36.0
Pair classic banner:   ▌ term²  STANDARD  v0.36.0       ▌ term²  PAIR  v0.36.0
Mentor classic banner:  ▌ term²  STANDARD   MENTOR      ▌ term²  STANDARD   MENTOR
```

### Commands and retained artifacts

- `pnpm test source/components/layout/bare-footer-probe.test.tsx`:
  baseline exit 1 (24 failures/32 passes); fixed exit 0 (56 passes).
  The baseline runner temporarily substituted only the four affected source
  files from the base revision in this isolated worktree, then restored the
  exact saved fix bytes in `finally`. Main was never checked out or modified.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed, 0 errors and 31 warnings in untouched files; Prettier passed.
- `pnpm build`: passed on the fixed source commit.
- `pnpm test`, after removing the temporary probe: 28 checks passed across all
  seven retained static guard files.
- `pnpm check:no-unit-tests` and `git diff --check`: passed.

Machine-local artifacts:

- `/tmp/bare-footer-probe-20261024.tsx` — final temporary probe, archived outside
  the checkout rather than committed as a permanent unit test. To repeat it,
  temporarily copy it to `source/components/layout/bare-footer-probe.test.tsx`,
  run the command above, then delete that copy.
- `/tmp/bare-footer-baseline-run-20261024.py` — matched baseline runner.
- `/tmp/bare-footer-final-baseline-20261024.{log,jsonl}` — baseline failures and
  actual rendered frames.
- `/tmp/bare-footer-committed-fixed-20261024.{log,jsonl}` — fixed committed-source
  result and actual rendered frames.
- `/tmp/bare-footer-{typecheck,lint,build,static}-20261024.log` — focused checks.

Exploratory fixtures were not product evidence: the first two runs incorrectly
used a named import for the default-exported footer, yielding empty frames even
for controls (28 failures each). A later fixture expected lowercase `codex`
instead of the real provider label `Codex` (30 failures/6 passes). The import,
provider assertion, and act-environment setup were corrected before the matched
baseline/fix comparison. Original logs remain at
`/tmp/bare-footer-before-20261024.log`,
`/tmp/bare-footer-baseline-20261024.log`, and
`/tmp/bare-footer-valid-baseline-20261024.log`.

## Proportionate retro

Preventable: yes. The invalid display was representable because a
`Record<string, string>` could silently omit real profiles and fall back to a
different identity. Bare's introducing commit
`c99f26d7d487942efc69859e6517cbe1547fc0d2` updated the registry and shared helper
but not the two UI maps; Pair was an older sibling from `37523fac`. This was a
display omission when profiles were added, not failed activation.

1. **Representability:** deleted the optional per-consumer membership maps.
2. **Single source:** registry names now feed the shared helper and both displays.
3. **Boundary:** preserved lowercase helper contract and unknown-ID fallback;
   casing/hiding remain consumer presentation.
4. **Coupling:** adding a registry profile no longer requires copying its name
   into three other lists.
5. **Assumption:** unknown-to-this-map was incorrectly treated as Standard.
6. **Detection:** no retained rendered profile-identity matrix covered these
   additions; the original Bare task recorded headless rather than interactive
   profile evidence.
7. **Automation:** the temporary registry-enumerated matrix detects omissions;
   no new static guard or permanent unit test was added.
8. **Siblings:** audited Banner, profile picker, resume menu/list, headless
   session/conversation labels, launcher seam, and all five skins. Banner shared
   the defect and was fixed; picker already derived names; remaining label
   consumers use the shared helper. Skins consume prepared identity text.
9. **Knowledge:** profile identity was already registry-owned, but independent
   display tables made that ownership unenforced.
10. **Observability:** Bare was added October 21 and reported October 24; exact
    first observation time is unknown. The rendered matrix exposes it directly.
11. **Origin:** omissions in new profile UI support; no evidence that Bare/Pair
    previously rendered correctly in these consumers.

The structural prevention is the deletion of the competing identity sources,
not a reminder to update them. No larger profile architecture is needed here.

## Limits

This is real service/filesystem/Ink-renderer evidence, not a full interactive CLI
PTY session. No full integration/e2e/provider suite was run; this patch does not
change their runtime paths. Other skins were sampled at 80 columns, not the
entire width/theme cross-product. Existing rail/zen banner default suppression
was not redesigned. New Bare/Pair badge colours reuse a previously shipped
swatch; visual contrast was not independently measured. Existing shared-label
consumers retain values for all current built-ins and unknown IDs, but their
whole workflows were not rerun. No independent verifier was required for this
medium-risk patch; controller review/integration is still pending.
