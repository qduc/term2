# Luna format-repro gauge

Paired experiment + reproducible-trigger gauge for Luna `apply_patch`
whitespace degeneration. See
`docs/research/luna-format-experiment-2026-09-04.md` for the full
pre-registration, production re-derivation (17 aborted Luna artifacts,
17/17 `apply_patch`, 16/17 whitespace-collapse), and verdict.

## What this is

`luna-format-repro.mjs` runs a paired A/B against the Codex Responses
endpoint (direct API, NOT the production app):

- Arm A — our `apply_patch` schema: patch body as a direct `diff` JSON
  string parameter (whitespace-semantic TS update hunks).
- Arm B — Codex shape: single `exec` tool whose argument is a JS program
  calling nested `tools.apply_patch` with the identical patch.

Primary metric (automatic, never eyeballed): per-probe whitespace-run
onset — `maxWsRun`, `contentEnd`, `wsFrac`, plus `fired`
(`maxWsRun >= threshold`, default 10k; production runaways show 40k–99k,
clean probes show single digits).

## Usage

```sh
node scripts/experiments/luna-format-repro/luna-format-repro.mjs [nProbes] [outPath] [wsFireThreshold]
```

Env: `FORMAT_N_HISTORY` (default 10), `CODEX_TOKEN` (default: read-only
from `~/.codex/auth.json`), `CODEX_BASE_URL` (endpoint override).

Exit code: 0 = all clean, 1 = ≥1 probe fired, 2 = harness error.
Result JSON carries `{ config, fireThreshold, arms: { A: { fired, n, probes },
B: {...} }, sentInputChars }` — the before/after gauge for any future fix
(schema change, cap, prompt change): re-run before and after, compare rates.

Cost reference: the v2 full run (10-turn history, 4 probes/arm) sent ~246k
input chars over ~9 minutes. Keep `nProbes` small.

## Result history

- v2 full run, 2026-09-04 (`/tmp/luna-format-repro/format2.json`,
  pre-threshold format — all probes recompute as clean under the 10k rule):
  A 0/4 fired (1.6–1.7k chars, maxWsRun ≤3), B 0/4 fired (1.6–2.1k chars,
  maxWsRun ≤4). No elevated rate; format NOT sufficient at this scale.
  Prime suspect remains server-side chained state (`previous_response_id`
  over long chains — the direct endpoint rejects it, so no replay harness
  can replicate it).
