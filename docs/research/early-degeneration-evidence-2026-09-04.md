# Early-degeneration evidence — candidate signals vs 9 drips + 2890 healthy args

Source: provider-traffic `2026-09-02/16-51-27_8b49b` (session 8b49b1ea).
Drips: 9 aborted Luna artifacts (raw `events` retained) + 3 1006 siblings
(counters only). Healthy: 2890 completed tool-call args across all tools.
Scripts: `/tmp/analyze.py /tmp/fp*.py /tmp/dripfire.py` (method), not shipped.

## Signal 1: n-gram repetition — DEAD. Fires at 1536 on everything.

8-gram/16-gram trailing-window repetition fires at the first checkpoint
(1536 chars) on all 9 drips AND on 331/2890 healthy args (11.5%), including
the 53,349-byte legitimate `create_file` (biggest healthy arg). YAML
artifacts legitimately repeat `replacementTestIds: []`, file paths, shard
names. KILLED BY: 331 false positives.

## Signal 2: whitespace-run / non-ASCII / `to=functions` window — NOISY.

Streaming sim (2KB–4KB trailing window from 2KB, checkpoints every 512B):

- Drips fire at 2.5k–56k (6/9 via `to=functions` leak, 2 via ws-run, 1 via
  non-ASCII). Genuinely earlier than 100k/60s: earliest 2,560 chars.
- Healthy: 9/2890 false positives (0.3%), ALL `apply_patch`. But inspection
  kills the signal's premise: the flagged regions sit INSIDE the JSON string
  (all 4 sampled parse whole-arg clean via `raw_decode`, struct_end == len),
  and all 4 calls EXECUTED (execution_started in app log). The model emits
  meta-commentary mid-argument and still closes valid JSON — the harness's
  lenient parser accepts it. Flagging `to=functions` inside a still-valid
  argument kills valid work. The one FP class that matters (large valid
  patches with chatty interiors) is exactly what the detector must spare.
- KILLED BY: cannot distinguish mid-argument chatter (valid, executed) from
  terminal degeneration without parsing — and at stream time we only have a
  cumulative count, not content (see below).

## Signal 3: per-tool ceilings — UPSIDE-DOWN.

Completed-arg distribution: apply_patch max 53,349 / p99 42,575;
run_subagent max 6,983; shell max 13,656. The 9 drips are all `apply_patch`
(the tool with the highest legitimate ceiling) and die at 100k — only 2x the
biggest legit patch. Any per-tool ceiling that spares 53k cannot catch a
100k drip meaningfully earlier than the global cap; any ceiling that catches
it (~25–60k) kills observed-legitimate work. The 25,179 figure from the
earlier report was the in-window max; full-day max is 53,349 — the margin is
even thinner than stated. KILLED BY: overlapping distributions.

## Signal 4: rate/entropy of deltas — NO SIGNAL.

Drip delta sizes: mean ~1.1–1.8 chars/frame; healthy large patches stream at
the same granularity (provider chunks JSON text identically for sane and
degenerate content). Frame rate reflects server pacing, not content quality.
Nothing to key on.

## Structural blocker (stronger than any signal result)

The run-loop's `tool_call_streaming_delta` carries ONLY `{toolName,
argumentCharCount}` — a cumulative count, no content. Every content signal
above requires the accumulated text, which exists only inside provider
adapters (`toolArgumentLengthsByIndex` counts, never retains). Building an
early content detector means threading argument text (or a sketch) from the
Codex converter through the event contract to the guard — a new data path
carrying unbounded model text, for a detector whose best measured precision
is 9 FPs per 2890 (0.3%, all valid executed patches). Cost/benefit fails
before design starts.

## Verdict: NO SIGNAL SEPARATES CLEANLY. Nothing ships.

- Outer backstop (100k cap + 60s drip guard) stands as the only layer.
- The 9 FPs are not tunable away: they are valid, executed, accepted patches.
  Any threshold movement trades drip-earliness against killing real M4 work.
- Honest earliest-distinguisher on the 9 drips (post-hoc, full-text): the
  `to=functions` leak at 4.4k–56k — unusable online for the reasons above.
- If this is revisited: the prerequisite is content-bearing deltas in the
  run-loop event contract, plus a structural-validity signal (JSON-prefix
  parse state), not a content heuristic. Re-measure then.
