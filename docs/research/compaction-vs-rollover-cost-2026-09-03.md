# Do compaction/rollover make the model dumber, and is the saving worth it?

Date: 2026-09-03. Extends `compaction-vs-rollover-2026-09-03.md`. Analysis
only; no code changed. All figures from last night's M4 chain (DeepSeek
`deepseek-v4-flash` root sessions; catalog input $0.0574/MTok, cached reads
$0.01148/MTok, writes free, output $0.1148/MTok).

Read first: `docs/research/model-effort-step-down-cache-economics.md` (hint,
not truth). Its directly relevant findings: cache invalidation dominates
mechanism cost math (Findings 1–2), and per-request routing must price the
miss (Finding 6, Cursor Compass). This audit does that pricing for
compaction and rollover on DeepSeek, where writes are free — so the only
cache cost is re-reading fresh tokens until the prefix re-caches.

Method note: quality cannot be read from a log, so §1 uses behavioural
proxies and says so. Cost (§2) is exact token accounting from the traffic
artifacts.

## 1. Intelligence cost: no detectable dumbing (proxies, stated as proxies)

Proxy set, per session from `tool_call.execution_started` (+1 error record):

| session | batches landed | tool mix | errors |
|---|---|---|---|
| 8b49b1ea (pre-boundary) | M3 closeout (28 artifacts) | 18 read / 163 shell / 10 search_replace / 41 run_subagent | 0 main-session errors |
| 7cb809c6 | B1+B2 | 15 read / 75 shell / 16 search_replace | 0 |
| 75fbce8c | B3+B4 | 43 read / 91 shell / 20 search_replace | 0 |
| 62b1a56a | B5 | 66 read / 144 shell / 42 search_replace | 1 `tool_call.parse_failed` (graph.yaml JSON, 04:29) |
| f925c980 | B6–B10 + topology | 59 read / 170 shell / 29 search_replace | 0 |

- No wrong-file/wrong-checkout edits, no contradicted pre-boundary decisions,
  no re-landed batches (B1–B5 landed exactly once each across the chain; the
  single parse failure was a same-session retry, not cross-boundary rework).
- Successors orient from disk artifacts by design (git log, plan-doc batch
  table), not from predecessor memory — re-reading a durable file is not
  re-derivation.
- Retrieval proxy: only f925c980 issued any `session_*` reads post-boundary
  (5 calls), i.e. successors almost never needed the predecessor transcript.
  The briefs were ~self-sufficient, matching the retrieval study's finding.
- Throughput proxy cuts the other way if anything: batches/session rises
  across the chain (0 → 2 → 2 → 1 → 6), so post-boundary work is not slower
  per unit. Confounders (batch sizes differ) make this weak evidence — but
  there is no signal of degradation in any proxy.

Stated plainly: these are proxies, and the app log's `execution_started`
carries no tool arguments, so a same-file re-read for a new reason is
invisible. Within that limit, post-boundary work is indistinguishable from
pre-boundary work. That is a real, useful finding.

## 2. Cost side: cache math per boundary (exact tokens)

Warm steady state (non-summarizer requests): ~99% cached, ~0.8–2.2k fresh
tokens/request. First request after every rollover: ~22k prompt, only 3,072
cached (14%) — ~19k fresh tokens to re-establish the prefix. Cache warmth
rebuilds by request #2 (≥90% cached immediately; DeepSeek re-caches the
surviving prefix in one shot, no multi-request ramp).

Per-boundary ledger (fresh = prompt − cached; $ at catalog rates):

| boundary | last-warm fresh/req | first-cold fresh (re-upload) | re-upload $ | successor session totals (fresh M / out M) |
|---|---|---|---|---|
| R1 → 7cb80 | ~0.5k | ~19k | ~$0.0011 | 0.08 / 0.06 |
| R2 → 75fbc | ~0.3k | ~19k | ~$0.0011 | 0.13 / 0.10 |
| R3 → 62b1a | ~0.3k | ~19k | ~$0.0011 | 0.53 / 0.15 |
| R4 → f925c | ~1.0k | ~19k | ~$0.0011 | 0.96 / 0.24 |

So each rollover costs a flat ~$0.001 one-time re-upload — noise against
session totals ($0.005–$0.03 fresh+output per session). The "99% cached,
dropping context is not free" framing is directionally right but
quantitatively negligible here: at these rates the re-upload is ~0.3% of a
session's token spend. Rollover is net positive in every case AND it was
needed (R3/R4 under real pressure; R1/R2 at task boundaries where the
alternative was carrying 140–205k of dead context).

Compaction's own price is different and larger: each successful compaction
pays a same-model summarizer call over the cold prefix — observed 165–481k
input tokens + 5–19k output (5 such calls last night: 2 in 8b49b, 1 in 62b1a,
2 in f925c). At catalog rates one 300k summarizer call ≈ $0.017 input +
$0.001 output ≈ **$0.018, ~15x the cost of a rollover re-upload.** The two
8b49b compactions cut 509→139 and ~103 opaque items: real relief, plausibly
worth $0.036. But the R5-backstop compaction (05:21, 108 dropped, 543→292
items) bought its relief at the same $0.018 unit price while a free rollover
was merely *deferred* by one live background shell — worth it that night,
but the cheapest backstop would have been waiting for the shell, not
summarizing 300k tokens.

Largest-fresh outliers (75–114k, non-summarizer) are new-large-tool-output
requests (full-suite runs), not cache invalidations — cache-miss shape would
be whole-prefix fresh, and these are not.

## Verdict

- Rollover: ~$0.001 re-upload, zero detected rework, 10x context cuts.
  Positive in all four cases. Not net negative anywhere.
- Compaction: ~$0.018 per success + zero detected rework. Positive where it
  fired (R1 pair, R4 assist), but an expensive way to buy what a free
  rollover provides — keep it as the blocked-rollover backstop (R5), not as
  the primary strategy.
- Neither mechanism made the model detectably dumber; the saving is real in
  both cases, and rollover's is nearly free.

Evidence commands (traffic dirs `provider-traffic/2026-09-02/<dir>/`):

```bash
L=~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-02
for D in 16-51-27_8b49b 19-19-23_7cb80 20-06-15_75fbc 20-54-16_62b1a 21-46-40_f925c; do python3 -c "
import json,glob
tp=tc=to=0
for f in glob.glob('$L/$D/*.json'):
    e=json.load(open(f))
    if e['sent']['model']!='deepseek-v4-flash': continue
    u=(e['received'].get('summary') or {}).get('payload',{}).get('usage',{})
    tp+=u.get('prompt_tokens') or 0; tc+=(u.get('prompt_tokens_details') or {}).get('cached_tokens') or 0; to+=u.get('completion_tokens') or 0
print('$D', round(tp/1e6,2), round(tc/1e6,2), round(to/1e6,2))"; done
```
