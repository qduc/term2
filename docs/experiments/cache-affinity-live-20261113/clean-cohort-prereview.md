# Independent clean-cohort prereview

Accept the current experimental safety/accounting controls for a fresh balanced cohort, subject to the enforced fresh-build/tool-preflight and shared-ledger startup gates. This is permission-independent engineering acceptance, not a live result. No paid calls, source rebuilds, production changes or remote writes were made by this verifier.

Reviewed uncommitted experiment-only changes from `380878a892a08ff1fe0db0c4050ab03c77d6cc5d`. Final hashes are recorded below. The parent must freeze the reviewed harness and obtain a matching fresh no-cost preflight/build receipt before launch; the runner refuses mismatched receipts. The prior live ledger remains 24 requests, $0.009997785 usage-priced estimate, zero missing usage, SHA256 `6b2c006cbf2358e5ab8c8961461c250b8c496574e71f161bf8740a84d1b00f22`.

## Independent no-cost failure-path execution

A real loopback HTTP fixture and isolated temporary ledgers exercised:

- Missing sandbox dependency output: refused before upstream dispatch, persistent guardrail-stop, restarted gateway refuses.
- Heuristic approval failure, LLM auto-approval failure, LLM rejection, sandbox denied read and sandbox blocked outputs: each refused before dispatch and remained stopped on restart.
- Generic `Tool execution was not approved.`: initial check exposed a gap, parent added the generic literal, independent retest passed with zero upstream requests and an empty ledger; restart also refuses.
- An upstream fixture response requesting `shell` with `sandbox: unsandboxed`: its one fake request is metered, gateway stops, then both same-process and restarted gateway reject further dispatch.

The unsandboxed-response gate detects a request after streaming the response to the CLI. It guarantees no later paid dispatch; normal unchanged tool approval remains responsible for whether that call executes. No product security policy is bypassed by this mechanism.

## Startup and capability evidence inspection

The runner requires a fresh cohort identifier and rejects stopped cohorts, absent/failed paid-free preflight, nonzero preflight unsandboxed count, or a build receipt differing from the currently certified build. It verifies the exact prior 24-entry snapshot digest and unchanged first 24 entries in the cumulative ledger. The parent plans to reuse the existing ledger by symlink, so its operational $2 ceiling includes prior spending rather than starting a new budget. The existing single-writer lock, physical-request reservation, unknown-usage halt, concurrency bound, per-run output/request bounds and global bound remain active.

New run IDs are cohort-prefixed. A ledger entry without a finalized result causes refusal rather than replaying an uncertain attempt. The runner captures tool calls/results, child-only elapsed time, required skill content, and successful public tests. The latter now requires all named immutable seeded public-test cases in a successful native shell result, along with a test invocation, exit 0, positive pass count and zero failures. All three frozen task seeds use syntax covered by the case-name extraction. Hidden-grader failure remains separately reported, without free repair feedback.

After each run, capability failures (absent actual skill/test evidence, unsandboxed requests, unauthorized artifact changes or gateway halt) stop the cohort and produce stopped metadata. Predispatch tool-result guards stop further billing on observed sandbox or approval failures. Initial settings, task seeds, native request bodies, tools, medium effort, HTTP transport, 32K ceiling, chaining and store semantics are otherwise unchanged between arms; the relay still varies only session-id.

## Limits

This prereview does not claim a new live cohort has run or succeeded. It does not replace the final frozen-build real-tool preflight or post-run native audit. Full hosted CI was not run. The old failed-capability sample must remain separate from repaired matched comparisons, while remaining included in total spending.

Reviewed harness SHA256:

```json
{
  "budget-gateway.mjs": "9217ed843cd02a206cd7bd8714629fdeafe06d72a1492093934e4cff17047dfc",
  "grade-candidate.mjs": "74d964bde89bc529b0727112409f4201f82b9451a9e092b70b78c427f803f4a4",
  "tool-preflight.mjs": "59c6d1f5c8ea4f7104f654e2379347ff1266879ea68b8e496a21b61f17486ef7",
  "run-comparison.mjs": "9e77ea32c7ec047a66dc6ced19b6b2e91e39fb66f03ba9c446db448fbbe6f79f",
  "workloads.mjs": "3b58731c2ab8d55b952e2b07371f0ec28ad7967ee2969c88b3ef75630b250345"
}
```
