---
name: release
description: Prepare and execute a Term2 project release. Use whenever the user asks to release, publish, cut a version, tag a release, or resume a release using this repository's release workflow.
---

# Release Term2

Follow the repository's release workflow in `scripts/release.sh`. The script is idempotent: inspect its current help and working-tree state, then rerun the same version command to continue after a recoverable failure.

## Workflow

1. **Inspect state.** Read `git status --short`, current branch, latest release tag, `package.json`, `CHANGELOG.md`, and `scripts/release.sh`. Identify unrelated or user-owned changes. Release only from the intended branch and establish what version the user wants; if they have not specified a bump, infer the smallest appropriate semver bump from unreleased changes, but ask if that choice is materially ambiguous.
2. **Prepare the changelog.** Write the release entry in `CHANGELOG.md` yourself, using the existing format and verified changes since the previous release. Group user-facing changes accurately and avoid claiming unverified fixes. The `term2 -l` generation inside the script is a fallback for human-driven releases, not the normal agent workflow. If changelog generation fails, inspect the error and continue with an accurate hand-written entry rather than repeatedly retrying a broken generator.
3. **Check and execute.** Review `scripts/release.sh --help` and choose flags that match the user's requested outcome. Run the repository's prescribed release checks; the script performs its own build gate. Keep release changes limited to the version/changelog files expected by the script. Use an explicit version when resuming an existing partial release.
4. **Publish safely.** The normal workflow pushes the release commit and `v<version>` tag, then delegates npm publishing to GitHub Actions Trusted Publishing. Pushing is an external, consequential action: proceed only when the user requested a release/push or the harness approval permits it. Use `--no-push` to prepare locally when remote publication was not requested. Use `--publish-local` only when the user explicitly wants the local token-authenticated fallback; it requires npm authentication.
5. **Verify and report.** Confirm the release commit, tag, package version, changelog entry, push result (if requested), and publish state from actual command output or remote/package status. Distinguish a pushed tag with CI publishing pending from a completed npm publish. Report the version, completed steps, remaining steps, and any failures.

   A publish step reporting success does not mean the version is readable yet. npm holds a newly published version back from its read surface for a while, so `npm view <pkg>@<version>`, the version doc, the tarball, and the provenance endpoint can all 404 for minutes after a publish that genuinely succeeded. Treat a 404 immediately after a successful publish as the expected lag, not as a lost publish: report the publish as done pending visibility and do not retry on that basis. See **Judging publish success** before concluding anything from a 404.

6. **Monitor GitHub Actions.** When the release tag is pushed, find the workflow run triggered by that tag with `gh run list` and monitor it with `gh run watch <run-id> --exit-status`. Confirm that the run corresponds to this release/tag. If `gh` is unavailable or authentication prevents access, report that CI monitoring could not be performed instead of implying that publishing completed.

7. **Repair CI failures.** If the release workflow fails, inspect its failed jobs and logs using `gh run view <run-id> --log-failed` (and the relevant job logs as needed). Trace each failure to its cause; make only release-related fixes in the working branch, run the narrow relevant checks locally, and commit/push the correction when the user-authorized release flow permits. Then monitor the resulting workflow run to completion. Keep the release tag/version consistent; do not create another version or retag an already-published release to work around a failure. Report unresolved failures with evidence and the next blocker.

## Judging publish success

Deciding whether a publish actually happened is easy to get wrong, because a 404 from the registry does not distinguish "the publish failed" from "the version is not readable yet". Work from the strongest evidence down.

**What the success line proves.** pnpm emits `✅ Published package <name>@<version>` only inside `if (response.ok)`, where `response` is the raw `libnpmpublish` result of the publish `PUT` to the registry; any non-2xx throws before that line, and a non-2xx means the publish did not happen. So the success line is positive evidence that the registry answered the publish request with 2xx — not proof that the version is readable.

**What a 404 does not prove.** A fresh version is held back from npm's read surface, so `npm view`, the version doc, the tarball URL, and `/-/npm/v1/attestations/...` can each 404 for minutes after a publish that succeeded. Do not conclude the publish was lost from a 404 alone, and do not retry on that basis.

**Do not dress up the same read path as independent confirmation.** unpkg, jsDelivr, and npmmirror all proxy or sync from `registry.npmjs.org`, and `npm view` reads the same packument; agreement among them carries no independent weight. Cloudflare cache-busting and a fresh `--cache` dir only rule out local and edge caching, not read-path lag. Do not use `replicate.npmjs.com` as a probe: it returns 404 for packages that plainly exist (including `react`), so its 404 means nothing.

**A usable control.** To show the read path is current rather than stale, query something genuinely fresh — e.g. `/-/v1/search` for a busy package and check that the newest results include publishes from minutes ago. Current results there plus a 404 for the release version means the write has not propagated, or did not land, and the two remain indistinguishable for a while; the control cannot separate them.

**Resolving it.** Wait for visibility rather than racing it; the version normally appears without action. Only if a release version stays invisible well beyond the expected window should you confirm from outside the sandbox (`npm view <pkg> version`) or re-dispatch the publish workflow via `workflow_dispatch` — the documented retry path, since a tag-triggered run whose tests fail cannot be re-run. Never create a new version to route around a visibility delay.

## Recovery

The release script is designed for reruns and skips completed steps. After a failure, inspect repository state and script output before retrying; do not manually duplicate commits, tags, or publishes. If npm publish may have succeeded despite a lost response, check whether that version is published before retrying — and read **Judging publish success** first, because a 404 may only mean the version is not yet readable. Preserve unrelated working-tree changes throughout.
