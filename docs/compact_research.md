Yes. I checked the current implementations in Aider, Gemini CLI, Pi, OpenCode, OpenHands, and Codex. There are really **three different families** hiding under the word “compaction.”

The interesting finding: **true divide-and-conquer compaction is rare, but it is starting to appear.** Gemini CLI now has an experimental implementation that is very close to what you describe.

| Harness               | Strategy                                          | Split before summarize? | Divide & conquer? |
| --------------------- | ------------------------------------------------- | ----------------------: | ----------------: |
| Gemini CLI default    | old 70% → summary → verify; keep recent 30%       |                       ✅ |                 ❌ |
| Gemini CLI Union-Find | topic clusters → independent summaries + hot tail |                      ✅✅ |                 ✅ |
| Aider                 | summarize head → keep tail → recursively repeat   |                       ✅ |                🟡 |
| Pi                    | summarize old prefix + keep recent ~20k           |                       ✅ |                 ❌ |
| OpenHands             | keep beginning + recent tail; summarize middle    |                       ✅ |                 ❌ |
| OpenCode              | prune outputs → summarize selected old history    |                       ✅ |                 ❌ |
| Codex                 | summary + bounded recent user-history bridge      |                      🟡 |                 ❌ |

The **Gemini default** is already more careful than “throw the whole context into a summarizer.” It first removes/truncates oversized old tool outputs, finds a safe turn boundary around the oldest 70%, summarizes only that portion, keeps roughly the newest 30% untouched, and then makes a **second LLM call to check the summary for missing technical details**. ([GitHub][1])

Conceptually:

```text
OLD ---------------------------------------- NEW

[----------- ~70% -----------][--- ~30% ---]
             │                    │
         summarize               keep
             │
          verify
             │
             ▼
       [state summary] + [recent messages]
```

That's “split before compact”, but it is **not divide-and-conquer** because the 70% cold section still goes through one summarization operation.

Aider goes one step further. `ChatSummary.summarize_real()` keeps roughly half its token budget as a recent tail, summarizes the older head, then checks the resulting size. If it is still too large, it recursively calls itself on:

```text
summary(head) + tail
       │
       └── too big?
               │
               ▼
        summarize again
```

There is a recursion-depth guard. So Aider really does have a recursive reduction algorithm. But it's still not classic map/reduce: it doesn't create N independent chunks, summarize all N, then merge their summaries. ([GitHub][2])

Pi is the classic rolling approach: walk backward until roughly `keepRecentTokens` (20k by default), summarize everything older than that, and use the previous summary as input during later compactions. ([GitHub][3])

Pi has one neat exception. If **one single turn itself is enormous**, it splits that turn and generates two pieces — the previous-history summary and a summary of the oversized turn prefix — then combines them. That's a tiny special-purpose map/reduce operation, but it isn't used for general history compaction. ([github.com][3])

OpenHands is similar but keeps both ends: some initial events are protected, recent events remain verbatim, and the middle gets replaced by one LLM-generated condensation event. ([OpenHands Docs][4])

OpenCode first removes earlier compaction messages, carries the previous summary forward, selects an old `head`, serializes that head, and gives it to one compaction model call. Interestingly, the code explicitly has an error path for the selected history itself being too large for the compactor — exactly the failure a real chunked algorithm would avoid. ([GitHub][5])

Codex is also essentially bridge replacement rather than hierarchical reduction. Its current local compaction code builds replacement history from a generated summary plus a bounded selection of recent user messages — currently up to about 20k tokens for those user messages. ([GitHub][6])

But then I found the really interesting one. 👀

**Gemini CLI's experimental Union-Find compactor is basically the architecture you're imagining.** Instead of treating history as one timeline to repeatedly squash, it maintains:

```text
              CONTEXT

┌─────────────────────────────┐
│ Hot recent messages         │  verbatim
├─────────────────────────────┤
│ Topic cluster A             │── summary A
│ Topic cluster B             │── summary B
│ Topic cluster C             │── summary C
│ Topic cluster D             │── summary D
└─────────────────────────────┘
```

Old messages “graduate” from the hot window. A local TF-IDF embedding groups them by semantic similarity into a union-find forest. Dirty clusters are then summarized **independently and asynchronously**, one summarizer call per cluster. Rendering the context gives cached cluster summaries + the untouched hot window. ([GitHub][7])

So rather than:

```text
100k history
    │
    ▼
ONE enormous summarization
    │
    ▼
10k summary
```

it moves toward:

```text
100k history

     split / cluster
          │
    ┌─────┼─────┬─────┐
    ▼     ▼     ▼     ▼
   20k   15k   30k   25k
    │     │     │     │
    ▼     ▼     ▼     ▼
   S1    S2    S3    S4
    └─────┼─────┴─────┘
          │
     context budget
          │
     merge/evict older
```

And importantly, **this isn't the Gemini CLI default yet**. As of the current roadmap, Union-Find is implemented behind the `COMPRESSION_STRATEGY` experiment flag; the default remains flat compaction. Its initial 12-conversation experiment reported lower token use and +8.3 percentage points recall, but the recall result was statistically inconclusive (`p=0.136`), so I would treat the quality numbers as promising rather than proof. ([GitHub][8])

I think your divide-and-conquer idea has a very strong property that most current harnesses miss: **the compactor itself never needs a context window large enough to consume the context it's trying to rescue.**

I would actually go slightly simpler than Gemini's Union-Find initially:

```text
raw history
     │
     ▼
remove/refer large tool outputs
     │
     ▼
protect hot tail
     │
     ▼
split cold history at turn/task boundaries
     │
 ┌───┴───┬──────┬──────┐
 ▼       ▼      ▼      ▼
chunk   chunk   chunk   chunk
  │       │      │      │
  ▼       ▼      ▼      ▼
 S1      S2     S3     S4       ← parallel
  └───────┴──┬───┴──────┘
             ▼
       reduce summaries
             │
        still too big?
          ↙       ↘
        yes        no
         │          │
   reduce again   done
```

That's basically **hierarchical/map-reduce compaction**.

And I think there's an important improvement over Aider: don't recursively summarize `summary + recent tail`. Keep the hot tail immutable. Only recursively reduce the **cold summaries**. That prevents recent information from getting repeatedly degraded.

So my preferred design would be:

`[hierarchical cold summary tree] + [verbatim hot tail]`

rather than today's common:

`[summary of summary of summary...] + [some recent messages]`

That feels like a genuinely better foundation for very long-lived agent sessions. 🔥

[1]: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts "gemini-cli/packages/core/src/context/chatCompressionService.ts at main · google-gemini/gemini-cli · GitHub"
[2]: https://github.com/Aider-AI/aider/blob/main/aider/history.py?utm_source=chatgpt.com "aider/aider/history.py at main"
[3]: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md "pi/packages/coding-agent/docs/compaction.md at main · earendil-works/pi · GitHub"
[4]: https://docs.openhands.dev/sdk/guides/context-condenser?utm_source=chatgpt.com "Context Condenser"
[5]: https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/compaction.ts "opencode/packages/opencode/src/session/compaction.ts at dev · anomalyco/opencode · GitHub"
[6]: https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs "codex/codex-rs/core/src/compact.rs at main · openai/codex · GitHub"
[7]: https://github.com/google-gemini/gemini-cli/issues/22877?utm_source=chatgpt.com "feat: Union-find context compaction as alternative to flat ..."
[8]: https://github.com/google-gemini/gemini-cli/discussions/26488?utm_source=chatgpt.com "Union-Find Compaction: Roadmap #26488"

---

**Yes — several open-source agent harnesses and compaction libraries use a “split before compact” (divide-and-conquer / map-reduce style) strategy**, especially when the history to summarize is itself longer than the summarizer’s context window.

### Typical patterns in open-source harnesses

Most production-style agent harnesses (Claude Code-style ports, OpenCode, Pi, OpenClaw/OpenHarness family, etc.) follow a two-stage pattern:

1. **Cheap micro-compaction / pruning first** (no LLM):
   - Clear or heavily truncate old tool results (`[Old tool result content cleared]`).
   - Drop or collapse oversized text blocks.
   - Keep recent turns + recent tool I/O intact.
   - This is fast and free.

2. **Full LLM compaction** when still over budget:
   - Cut at a safe boundary (usually turn boundary, or carefully preserving tool_use/tool_result pairs).
   - Summarize the older portion.
   - Keep a recent tail verbatim (often 15–40k tokens or last N turns).
   - Store the summary in the session transcript so future turns see summary + recent messages.

When the “older portion” is itself very long, pure single-shot summarization fails. That is where **split → summarize → merge** appears.

### Projects that explicitly split before compacting

**1. `context-compact` (HalfEmptyDrum/Context-Compactor)**
Explicit divide-and-conquer:

- Splits the messages-to-summarize into chunks that fit the summarizer’s context window (`maxChunkTokens`).
- **Sequential mode (default)**: running summary is carried forward (`previousSummary` is passed into the next call). This preserves cross-chunk coherence.
- **Parallel mode**: for very long histories, split into `parts` (default 2), summarize independently, then merge.
- Designed specifically for long-running agent loops. Integrates with Anthropic/OpenAI SDKs via a `SummarizeFn` callback.

This is the cleanest pure “split before compact” implementation among the libraries.

**2. OpenClaw (and related OpenHarness ports)**
The compaction code contains explicit chunking logic:

- `splitMessagesByTokenShare(messages, parts)` (default `parts = 2`)
- `chunkMessagesByMaxTokens`
- Constants like `BASE_CHUNK_RATIO = 0.4`, `MIN_CHUNK_RATIO = 0.15`, safety margins on token estimates.
- When history is long enough and `parts > 1`, it splits by approximate token share, summarizes the parts, then merges the summaries.
- Also does careful boundary adjustment so tool_use / tool_result pairs stay together.

OpenClaw is a full agent harness with auto-compaction, manual `/compact`, and pluggable context engines.

**3. CompactBench’s built-in methods**
Includes `hierarchical-summary` (and `hybrid-ledger`). Hierarchical approaches inherently involve multi-level splitting/summarization. The benchmark is specifically designed to test how well different compaction methods (including hierarchical ones) preserve information across multiple compaction cycles.

**4. Research: Parallel Context Compaction (PCC)**
Paper “Parallel Context Compaction for Long-Horizon LLM Agent Serving” (2026):

- Partitions history into contiguous blocks.
- Each worker sees a *prefix-aware* view (full history up to its block + target marker at the end).
- Summarizes in parallel, then concatenates.
- Gives the operator direct control over summary volume via block size and yields better throughput + more stable output volume than sequential single-shot summarization.

This is research rather than a packaged open-source library, but the design is exactly “split before compact + parallel map-reduce with cross-block awareness.”

### Other related open-source approaches

| Project / Component              | Split / Divide strategy?                          | Notes |
|----------------------------------|---------------------------------------------------|-------|
| OpenHarness / Claude Code ports | Micro-compact + full summary; some context-collapse | Mostly sequential; careful about tool pairs |
| Pi coding agent                  | Summarizes older content; handles mid-turn splits | Turn-based cutting + special handling for oversized turns |
| supercompact                     | Score-and-select (keep important turns verbatim)  | No LLM summary; avoids paraphrasing loss |
| ContextZip, claw-compactor, etc. | Rule-based / semantic token pruning               | Often lossless or near-lossless; different paradigm |
| Various proxies (Kompact, Compresr Context Gateway, etc.) | History compression + tool-output compression | Usually sequential or background summarization |

### Why split-before-compact is useful

- Summarizer itself has a context limit.
- Single-shot summarization of very long histories tends to be lossy, unstable in length, and slow (blocking).
- Sequential running-summary preserves more global coherence.
- Parallel (or hierarchical) versions give better latency/throughput and more predictable summary volume.
- Academic work on divide-and-conquer for long-context tasks shows that for many agent-relevant workloads (QA, retrieval, summarization with moderate cross-chunk dependence), splitting can *outperform* single-shot even with weaker models, because model noise grows super-linearly with length.

### Summary

Yes — the divide-and-conquer pattern (split → summarize chunks → merge / carry running summary) is used in open-source agent tooling. The clearest implementations are:

- **`context-compact`** (explicit sequential + optional parallel parts)
- **OpenClaw’s compaction module** (token-share splitting into parts)
- Hierarchical methods in CompactBench
- Parallel block designs in recent research

Most production harnesses still prefer the simpler “prune first + single summary of the older half” for the common case, and only fall back to multi-chunk processing when the history to compact is extremely long.