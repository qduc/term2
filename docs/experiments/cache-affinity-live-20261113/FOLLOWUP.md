# Follow-up: existing socat path repairs sandbox and test approval

No software installation or security-setting change was necessary.
`/workspace/setup-term2.sh` already selects `/workspace/.local/usr/bin`, and the
saved environment contains the working socat 1.8.0.3 binary there. The inherited
experiment harness instead prepended `/workspace/scratch/sandbox-bin` and omitted
the configured local bin directory. The repair prepends the existing directory
only to the experiment child's PATH; no global environment/configuration changes.
Binary SHA256: `676c9fda367e480b51d752259399d56ee4f1eb3ff811d935db22f917d8dc9499`.

The earlier report's phrase “environment lacks socat” was too broad: socat was
unavailable to the experiment process, but present in the saved workspace. The
approval denials were a downstream consequence. `shell.needsApproval` in
`src/tools/system/shell.ts` permits normal sandboxed execution when availability
is established. When dependency detection failed, execution entered the approval
fallback; `node` is YELLOW and `NonInteractiveApprovalPolicy` requires an explicitly
configured chore model. No chore model was configured. The separate evaluator's
documented fallback does not establish permission to change that security policy.
The PATH repair restores the existing sandbox route without changing the policy,
adding a chore model, expanding an allowlist or selecting an always-approve mode.

## Executed no-cost preflight

Exact tested HEAD: `76a92a1b1a06d84e860a3e2dfe0bc5bf67df9043`.
Product source/package/lock remain equal to PR271; only experimental PATH handling
and a loopback preflight script changed. The build passed with a fresh provenance
receipt. The script has no paid mode; all model requests terminate at a loopback
fixture through the existing relay and native OpenAI SDK.

Four fixture exchanges drove these actual application effects:

1. `shell`, sandbox default: read the node-contracts skill successfully.
2. `apply_patch`: edit the seeded pagination source; returned `Updated src/pages.mjs`.
3. `shell`, sandbox default: `node --test test/public.test.mjs`, exit 0, 2 tests pass,
   0 fail, observed in the next native tool-result request.
4. Final fixture reply.

There were no `approval_rejected` events, no unsandboxed calls, no helper-model
requests and no test/skill/source changes outside the owned scratch task. The
separate external public-test invocation also passed. The fixture meter's
$0.000048 synthetic usage arithmetic is **not paid spending**. Generic runner
`fixtureReply=false` means its old one-request reply predicate does not apply to
a four-request tool fixture; the dedicated tool-preflight oracle passed.

An initial no-cost attempt executed all three tools successfully but its oracle
expected TAP `# pass` output while Node emitted its spec reporter `ℹ pass`; the
oracle was corrected to require exit 0 and the pass/fail counts from either format,
then rerun against a fresh workspace. A lint-only unused variable was removed.
No paid request was used to debug these preflight issues.

Reproduce with a freshly built current checkout and an unused absolute root:

```sh
BENCH_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/tool-preflight-new NODE_USE_ENV_PROXY=1 node docs/experiments/cache-affinity-live-20261113/tool-preflight.mjs
```

See tool-preflight-evidence.zip, tool-preflight-result.json and path-repair-review.md.
The archive excludes client state/cache and credentials and retains exact build
provenance, native tool calls/results and final source. The inherited per-run
manifest still names the product base by default; provenance-note.json and the
build receipt disambiguate the actual tested experimental HEAD. No hosted CI or
live-provider behavior is inferred from this scripted fixture.

## Paid investigation boundary

No further paid cohort was launched. All prior 24 live requests, their failures
and $0.009997785 published-rate estimate remain counted; uncertain exposure is $0.
The stopped cohort remains inconclusive and must not be resumed as a clean sample.

A later clean cohort must preserve the existing cumulative ledger and reservations,
preregister fresh unique run identities and balanced matched order, use the same
three synthetic tasks and previously approved prompt/tool/output data only at
`https://api.openai.com/v1/responses`, and keep the native Luna HTTP/chaining/effort/
output/tool contracts fixed except the affinity header. Carry forward the $100
TOTAL investigation limit and $2 operational ceiling; one physical request at a
time, reserve before dispatch, include ancillary requests if ever introduced,
retain failed calls, and stop on missing usage or capability failure. Do not reset
spending to zero or reclassify these repaired fixtures as live-provider evidence.
This follow-up establishes readiness of the repaired tool path, not cache savings.
