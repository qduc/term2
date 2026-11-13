# Independent PATH repair and tool preflight review

**Accept the bounded harness repair and no-cost capability preflight.** This does not rehabilitate the stopped live cohort or establish live cache-affinity savings.

Reviewed commit `76a92a1b1a06d84e860a3e2dfe0bc5bf67df9043`. Its code changes replace the experiment child PATH prefix `/workspace/scratch/sandbox-bin` with `/workspace/.local/usr/bin` and add the loopback-only `tool-preflight.mjs`. Product `src/`, package and lockfile bytes remain identical to PR271 head `b1c2e4df329a371d2867f4224ba72ca83220e8a4`. No package installation, system configuration edit, credential change, chore-model configuration, approval policy change, or sandbox setting change is part of the repair.

## Evidence for the cause

An independent PATH lookup resolves no `socat` using the inherited PATH. The old harness prefix directory does not exist. Prefixing the existing `/workspace/.local/usr/bin` resolves its `socat` symlink; the executable hash is `676c9fda367e480b51d752259399d56ee4f1eb3ff811d935db22f917d8dc9499`. This is an existing saved-environment capability, not a new installation by this verifier.

The sandbox runtime's Linux dependency checker searches PATH for `socat`. `AnthropicShellSandboxRunner.availability()` returns unavailable on dependency errors. In unchanged `src/tools/system/shell.ts`, `needsApproval` returns false for default local sandbox commands when that sandbox is available; explicit unsandboxed requests still require approval. Execution then wraps the command in the sandbox and refuses an unsandboxed fallback on initialization failure. These source contracts explain the observed progression from missing dependency to unsandboxed recovery requests and approval denials in the stopped cohort.

The repaired preflight succeeds without configuring the missing approval model because its shell commands stay in the working default sandbox. This evidence applies to the exercised commands; it does not imply that all arbitrary commands will be approved.

## Independent execution

I independently reran the preflight in a fresh root:

```sh
BENCH_ROOT=/workspace/term2/.worktrees/cache-affinity-live/.handoff/cache-affinity-tool-preflight-independent NODE_USE_ENV_PROXY=1 node docs/experiments/cache-affinity-live-20261113/tool-preflight.mjs
```

The run exited 0 and produced four physical **loopback fixture** exchanges, all recorded as `mode: fixture`. Native model responses were scripted; no paid provider was called. The real CLI executed, in order:

1. `shell`, sandbox `default`: read the required skill, returned exit 0 and expected skill content.
2. `apply_patch`: edited `src/pages.mjs`, returned `Updated src/pages.mjs`; retained artifact confirms the edit.
3. `shell`, sandbox `default`: executed `node --test test/public.test.mjs`, returned exit 0 with **2 passed / 0 failed**.
4. Final scripted `PREFLIGHT_OK` reply.

The actual CLI trace has zero approval rejections and zero unsandboxed tool calls. Runtime settings retain `sandbox.enabled: true`, with no shell approval settings added. The independent summary reports `passed: true`, an empty errors array, and external public-test exit 0. The earlier author fixture was separately inspected and matches these outcomes.

The generic one-request fixture result reports `fixtureReply: false` and synthetic `meteredUsd: 0.000048`; these are expected artifacts of reusing its meter for a four-request fixture and must not be described as paid inference or fixture failure. `tool-preflight.json` is the dedicated four-step success contract. It distinguishes zero paid requests/cost from synthetic fixture token pricing.

## Provenance and limits

The actual independent test used `dist/.term2-build-provenance.json` with head `76a92a1b1a06d84e860a3e2dfe0bc5bf67df9043`, input digest `45ebe693879120e1aa93f8fbdcc4ea5c235586871a6c30ce93eca051552de430`, and output digest `4bddaf1c8fccc9c8da8c875697d8a578d109f8bce82c8aafbd556a62af9bec0a`. The preflight calls `assertFreshBuild` before executing. Any inherited manifest default naming PR271 head should be described as product-source ancestry, not the complete harness/build revision tested; retain the actual receipt in published evidence.

The live ledger remains **24 requests / $0.009997785 usage-priced estimate / $0 uncertain exposure**. Its SHA256 remains `6b2c006cbf2358e5ab8c8961461c250b8c496574e71f161bf8740a84d1b00f22`. I made no paid calls or remote writes and did not modify this ledger. No repaired live cohort was run by this verifier. Hosted CI and exhaustive sandbox-security verification were not performed. This preflight establishes the exercised real shell/edit/test path, not provider performance, stochastic task completion, every capability, or cache-routing behavior.

Supporting independent evidence is under `.handoff/cache-affinity-tool-preflight-independent/`: `tool-preflight.json`, fixture ledger/native exchanges, CLI stdout, retained task artifact, and external public-test output.
