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

6. **Monitor GitHub Actions.** When the release tag is pushed, find the workflow run triggered by that tag with `gh run list` and monitor it with `gh run watch <run-id> --exit-status`. Confirm that the run corresponds to this release/tag. If `gh` is unavailable or authentication prevents access, report that CI monitoring could not be performed instead of implying that publishing completed.

7. **Repair CI failures.** If the release workflow fails, inspect its failed jobs and logs using `gh run view <run-id> --log-failed` (and the relevant job logs as needed). Trace each failure to its cause; make only release-related fixes in the working branch, run the narrow relevant checks locally, and commit/push the correction when the user-authorized release flow permits. Then monitor the resulting workflow run to completion. Keep the release tag/version consistent; do not create another version or retag an already-published release to work around a failure. Report unresolved failures with evidence and the next blocker.

## Recovery

The release script is designed for reruns and skips completed steps. After a failure, inspect repository state and script output before retrying; do not manually duplicate commits, tags, or publishes. If npm publish may have succeeded despite a lost response, check whether that version is published before retrying. Preserve unrelated working-tree changes throughout.
