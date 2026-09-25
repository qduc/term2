# Evaluating long-term memory beyond one recall checkpoint: source-backed evidence

Status: **research note; no implementation.** Written 2026-09-25. Every source
listed in §8 was fetched and read directly in this session (2026-09-25). This
note deliberately does **not** re-review the memory technology landscape or the
architecture decision — that is
`docs/research/teammate-like-memory-direction.md` (2026-09-24, same repo). It
goes deeper on one question only:

> How are multi-session memory and user **corrections** actually evaluated, what
> do the measurements show about their limits, does the evidence transfer to a
> **coding** assistant, and what does it imply for the planned comparison of arm
> **A** (recency index) against arm **B** (task-relevant retrieval) described in
> §7 of the teammate-memory note?

The organising critique: a "seeded recall checkpoint" benchmark ingests a history
and then asks questions **once**, usually in question-answer form. That format
removes the hardest step — deciding that memory is needed at all — and cannot
express a correction that must survive several later sessions. The newer work in
§1 responds to that gap in several different ways, each of which says something
about which protocol shape to copy.

## 0. Evidence classes used below

- **[Measured]** — a primary result the authors publish for the artifact they
  built, with a protocol I read. **No number in this note has an independent
  replication that this search found**; most are single-paper results on the
  authors' own benchmarks.
- **[Self-reported prototype]** — the same paper's newly proposed system beating
  baselines in that paper.
- **[Vendor-reported]** — first-party benchmark from a vendor with a commercial
  interest in the result.
- **[Provider doc]** — first-party product documentation.
- **[Hypothesis]** — my inference, not measured.

## 1. What each protocol design actually measures

Read together, these nine protocols cover the design space. The "one checkpoint?"
column is the point of this note.

| Protocol | Unit of evaluation | Prompt signals retrieval needed? | Correction / staleness probes | Cost + latency reported |
| --- | --- | --- | --- | --- |
| [LongMemEval](https://arxiv.org/abs/2410.10813) | one question per compiled history | yes (direct question) | knowledge-update + abstention types | no (accuracy + recall only) |
| [MemoryAgentBench](https://arxiv.org/abs/2507.05257) | many questions per context | yes | selective forgetting (FactConsolidation) | yes (latency tables; cost-per-query appendix) |
| [STALE](https://arxiv.org/abs/2605.06527) | 3 probes per scenario | no for premise-resistance / policy probes | implicit conflict, 2 types | no |
| [HaluMem](https://arxiv.org/abs/2511.03506) | per-session operation checks | n/a (inspects memory state) | memory-updating consistency | yes (ingestion vs retrieval time) |
| [MemOps](https://arxiv.org/abs/2607.12893) | 6 operation-level probes, 2 settings | partially (action-style probes) | update / forget / stale-value distractors | no |
| [DolphinBench](https://arxiv.org/abs/2609.24971) | task completion (tool calls) | **no** (action-style) | none dedicated | **required** |
| [VibeMemBench](https://arxiv.org/abs/2609.23570) | executable SWE target, memory on/off | no (task is the signal) | none dedicated | tokens+steps only (no wall-clock) |
| [DreamBench-SWE](https://arxiv.org/abs/2608.20664) | S3 trap after S1+S2 setup sessions | no (trap is hidden) | stale-architecture, scoped feedback, flaky-test, abstention | per-success-cost artifact only |
| [AgentMemBench](https://arxiv.org/abs/2608.00009) | QA turns over 3 dialogue datasets | yes | none dedicated | latency + memory footprint |

Concrete design features worth stealing, each with its source:

- **Certify that the test can only be passed with memory.** DolphinBench runs
  every task with and without the relevant history and keeps only tasks that
  succeed with it and fail without it
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)). Without this, a
  benchmark score has an unknown ceiling.
- **Offer an oracle-retrieval setting** so retrieval and reading can be scored
  separately. LongMemEval ships `longmemeval_oracle.json` (evidence sessions
  only) alongside the 115k-token and 500-session variants
  ([repo README](https://github.com/xiaowu0162/LongMemEval)).
- **Score at several checkpoints, not one.** DreamBench-SWE is a sequence of S1
  (evidence) → S2 (reinforce/revise) → S3 (trap), scored by an executable oracle
  that the agent's container cannot read
  ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)). STALE issues three
  distinct probes against the same fixed memory: explicit (state resolution),
  adversarial (premise resistance), and implicit (policy adaptation)
  ([arXiv:2605.06527](https://arxiv.org/abs/2605.06527)).
- **Make the probe test a decision, not a fact.** DolphinBench's argument is
  that "what messaging platform does the team use?" already announces which fact
  is wanted, so the evaluation starts after the hard part; an action-style task
  ("post the update in the team's channel") never names the platform
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)).
- **Include recency-salient distractors.** MemOps deliberately plants
  `recency-top`, `same-target`, and `stale-value` distractors so that a system
  cannot pass by "retrieve whatever is newest/closest"
  ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
- **Report provenance/evidence paths, not just answers.** MemOps attaches gold
  provenance and an auditable reasoning chain so an answer is rejected if the
  required evidence path is absent
  ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
- **State what the format cannot do.** DolphinBench's own limitation: ingestion
  and testing are separated, which "does not test how they handle new
  conversations and tasks arriving throughout an ongoing evaluation"
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)). LongMemEval's repo
  records a later cleaning pass over the history sessions whose stated purpose
  was to "prevent interference on answer correctness," with the cleaned
  benchmark published separately on Hugging Face — i.e. the original haystacks
  contained sessions that corrupted intended answers
  ([repo README](https://github.com/xiaowu0162/LongMemEval),
  [cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)).

## 2. Measured limitations

### 2.1 Corrections and stale state: recognising is not acting

STALE is the most direct measurement of "the user corrected or superseded
something earlier." It is 400 expert-validated implicit-conflict scenarios
(1,200 queries) in contexts up to 150K tokens, where a later observation
invalidates an earlier belief without explicit negation
([arXiv:2605.06527](https://arxiv.org/abs/2605.06527)). Reported results:

- Best evaluated model, Gemini-3.1-pro, reaches **55.2% overall**; most systems
  are far below (Qwen3.5-27B 31.3%, Gemini-3.1-flash-lite 22.4%, most memory
  frameworks below 10%).
- **Premise resistance is the weakest dimension**: Gemini-3.1-pro scores 92.0%
  on explicit Type-I state resolution but only 30.0% on the adversarial probe
  that presupposes the stale state; Qwen3.5-27B drops 76.0% → 4.0%. Models
  "comply when a query presupposes the outdated state."
- **Adding a memory module does not fix it**: among frameworks on the same
  GPT-4o-mini backbone, only LightMem (17.8%) beats the plain model (8.7%).
- LightMem diagnostics: updated evidence is retrieved for 77.5% of
  state-resolution/premise cases, yet the **old** evidence is ranked top-1 in
  88.2% of state-resolution cases; where the top-3 recalled entries do contain
  the old evidence (60.5% of memory-construction cases), only 3.3% of those old
  entries were judged to require an update. The authors name this the
  **current-state adjudication gap**.
- Their prototype CUPMem (write-side state adjudication) reports 8.7% → 68.0%
  on the same backbone, with premise resistance 78.0%/75.0% Type I/II
  **[Self-reported prototype]**.

Corroborating results: MemoryAgentBench's selective-forgetting dataset
(FactConsolidation, built from MQUAKE counterfactual edit pairs) shows "all
methods fail on the multi-hop situation (at most 28% accuracy)"
([arXiv:2507.05257](https://arxiv.org/abs/2507.05257)). DreamBench-SWE's
stale-architecture and scoped-feedback traps are the same failure shape inside a
SWE repo ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)). TANGLE
additionally shows a **recognition-to-action gap** when conflicts are genuinely
unresolvable: models "recognize conflict more reliably than they calibrate
actions or seek targeted clarification," with clarification the lowest-scoring
dimension for every model ([arXiv:2608.13921](https://arxiv.org/abs/2608.13921)).

### 2.2 False memory and updating omission

HaluMem is the operation-level benchmark: it scores memory extraction, memory
**updating**, and memory QA separately, with a **False Memory Resistance** metric
for "distracting content that the AI mentions but the user does not confirm"
([arXiv:2511.03506](https://arxiv.org/abs/2511.03506)). Reported, on
HaluMem-Medium ([arXiv:2511.03506](https://arxiv.org/abs/2511.03506)):

| System | Memory-updating correct | Updating omission | False-memory resistance | QA hallucination rate |
| --- | ---: | ---: | ---: | ---: |
| Mem0 | 25.50% | 74.02% | 56.80% | 19.17% |
| Memobase | 5.20% | 94.25% | 80.78% | 29.97% |
| MemOS | 62.11% | 37.48% | 44.94% | 15.17% |

The authors' reading: hallucinations "accumulate during the extraction and
updating stages, which subsequently propagate errors to the question answering
stage." On their long tier, Mem0's extraction recall collapses to 3.23%.

This is the quantitative version of the poisoning/trust argument in the
teammate-memory note §4: the harm is not only adversarial injection, it is
ordinary update failure.

### 2.3 Retrieval interference: real, but not monotone

Evidence that more or more-similar context hurts:

- SWE-Bench-CL's "prompt poisoning" experiment prepends an unrelated issue-patch
  pair to a target task and measures semantic drift of the generated solution:
  **average drift ≈ 0.45** (1 − cosine), above their 0.3 "high drift" threshold,
  across difficulty groups ([arXiv:2507.00014](https://arxiv.org/abs/2507.00014)).
- VibeMemBench's irrelevant-memory control "stays **0.7 to 3.4 points below**
  the memory-off baseline on each of the three solvers that run it, so injected
  text alone reproduces none of the gains"
  ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)).
- MemOps: "dispersing that evidence into a larger, distractor-laden history
  consistently degrades both answer accuracy and operation-level reliability"
  ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
- "The Immutable Past" names *semantic shadowing* and a *majority-vote trap* in
  which enlarging the retrieval window dilutes attention and degrades accuracy,
  and reports its GC-Mem prototype recovering >90% conflict resolution
  **[Self-reported prototype, claim-heavy paper]**
  ([arXiv:2609.16073](https://arxiv.org/abs/2609.16073)).

Evidence in the other direction — the tension matters:

- MemoryAgentBench: "increasing the number of retrieved chunks **generally
  improves** performance across most tasks," while noting that 10 chunks × 4096
  tokens ≈ 40k tokens of input
  ([arXiv:2507.05257](https://arxiv.org/abs/2507.05257)).
- VibeMemBench: a Mem0 dose curve from one to five injected records "stays below
  the memory-off baseline at every budget," and the paper states that "uniform
  top-1 injection is not a neutral default"
  ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)).

So interference is a *quality* problem (wrong or stale record, context volume),
not simply a *quantity* problem. A bounded top-k is not automatically right or
wrong; which records and how much context they carry decides it.

### 2.4 Cost and latency, as measured

- **Injected memory is a separately attributable cost.** Total Cost of Agency
  measures it with a two-pass non-billable token count on a 200-task enterprise
  benchmark: memory injection is 13.6% of the variable cost an optimiser can act
  on, ~12% of full billed cost, rising from structurally zero at workflow depth
  one to **27.6% at depth six**; injected tokens grow linearly with depth
  (R² = 0.9974). Cutting the retrieval window from 32 to 2 entries reduced
  injected tokens by **28.7%** with accuracy change "within seed-level
  variation." Prompt caching was **not** evaluated; all figures are uncached
  ([arXiv:2609.23790](https://arxiv.org/abs/2609.23790)).
- **Write/ingestion is the bottleneck, not retrieval.** In HaluMem, "dialogue
  addition requires substantially more time than memory retrieval"; Mem0 and
  Mem0-Graph exceeded 2,700 minutes of ingestion time on the medium set
  ([arXiv:2511.03506](https://arxiv.org/abs/2511.03506)).
- **Accuracy–latency trade-offs are real and not monotone.** LME-V2 reports the
  off-the-shelf coding-agent baseline at 69.3% accuracy but ~182 s per query,
  "about 6.9 times slower" than the RAG-style AgentRunbook-R (≈26 s), while
  AgentRunbook-C reaches 72.5% and is 32% faster than Codex at query time
  ([arXiv:2605.12493](https://arxiv.org/abs/2605.12493)).
- **A shorter agent trajectory is not evidence of useful memory.** VibeMemBench:
  "All four systems cut glm-5 tokens and steps markedly, yet only one converts
  the shorter interaction into a resolution gain"
  ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)). DolphinBench's examples
  go both ways: one configuration improves accuracy 5 points *and* cuts median
  latency 44.35 s → 37.69 s while raising total cost $61.48 → $96.21
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)).

### 2.5 The measurement itself is fragile

- **Rankings are configuration-dependent.** DolphinBench: "the memory systems
  rank differently across configurations" and "the most expensive agent is
  neither the most accurate nor the fastest"
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)).
- **LLM judges can accept the wrong thing.** DolphinBench reports (citing
  Penfield Labs, which I did not read) that "one evaluated judge configuration
  accepted approximately 63% of deliberately incorrect, topically related
  answers," and MemOps attributes some of its cross-setting instability to
  "LLM-based judge … instability"
  ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971),
  [arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
- **Hygiene metrics can be collinear.** DreamBench-SWE discloses that several of
  its eight hygiene metrics "are numerically identical to one another for each
  ladder condition … (a judge artifact)," and that its HarmfulMemoryRate was
  0.000 for every condition
  ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).
- **Small effects need large n.** VibeMemBench's transfer gains of 1.1–4.5
  percentage points over 111 targets × 4 seeds have **every bootstrap interval
  crossing zero**: "directional evidence rather than effects separable from
  zero" ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)).
- **Non-rejection is not equivalence.** DreamBench-SWE's pre-registered primary
  contrast was null (95/180 vs 89/180, clustered p = .518) and it explicitly
  refuses to read that as a win *or* as equivalence, and reports a failed
  useful-memory-precision falsifier (0.264 vs 0.556)
  ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).

## 3. Does any of it transfer to a coding assistant?

There is **no primary benchmark of cross-session memory for a coding assistant
that has been independently replicated**. The nearest evidence, in order of
proximity:

- **VibeMemBench** is the closest analogue: SWE-rebench V2 targets with
  executable tests, matched memory-on/memory-off runs at fixed agent, tools,
  sandbox and budget. Verified useful experience injected directly raises
  Resolved on four of five solvers by 1.1–4.5 points and lowers agent steps on
  all five — but when four existing memory systems (Mem0, SimpleMem, MemoryOS,
  A-MEM) must construct and retrieve the record themselves, **11 of 12
  solver×system pairings stay at or below the matched memory-off baseline**
  ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570); repo:
  [AlibabaResearch/DAMO-ConvAI](https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/VibeMemBench)).
- **DreamBench-SWE** is the closest analogue for *hygiene*: multi-session SWE
  traps (stale architecture, scoped reviewer feedback, generated-file
  boundaries, flaky-test lessons, abstention) scored by hidden executable
  oracles. External memory 21/180; deterministic verbatim event memory 82/180;
  typed+raw reference probe 83/180; one pinned hosted Mem0 configuration 97/180.
  Its own conclusion is that this "does not establish an external-system
  mechanism, superiority among memory-bearing conditions, equivalence, or broad
  product generality"
  ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).
- **CTIM-Rover** (already cited in the teammate-memory note) added
  repository-level episodic memory to a working SWE agent and found the agent
  "does not outperform AutoCodeRover in any configuration," attributing the
  degradation to "noise introduced by distracting CTIM items or exemplar
  trajectories" ([arXiv:2505.23422](https://arxiv.org/abs/2505.23422)).
- **SWE-Bench-CL** is a protocol/benchmark contribution, not a result: 8
  repositories, 273 chronologically ordered tasks, plus continual-learning
  metrics (forgetting, forward/backward transfer, tool-use efficiency, CL-Fβ).
  Its preliminary harness run produced pass rates generally below 8.5% with the
  memory-enabled condition "on par with or slightly worse," and it documents
  that static patch-only harnesses fit evolving benchmarks poorly
  ([arXiv:2507.00014](https://arxiv.org/abs/2507.00014)).
- **LME-V2** covers web environments (WebArena/WorkArena) with 451 manually
  curated questions over five abilities including **premise awareness**, and
  reports answer accuracy plus query latency
  ([arXiv:2605.12493](https://arxiv.org/abs/2605.12493)). Its "experienced
  colleague" framing is the same goal as ours, but the domain is browsers, not
  repositories.

**What transfers is the protocol shape, not the numbers.** Every number above is
tied to a specific harness, model, prompt and budget. Conversely, the
persona/dialogue benchmarks (STALE, HaluMem, TANGLE, MemGuide, AgentMemBench)
should be read as *mechanism* evidence — corrections, false memory, interference
are real and measured — while the code benchmarks are *outcome* evidence and are
almost uniformly negative or null for off-the-shelf memory systems.

## 4. Implications for arm A (recency) vs arm B (task-relevant retrieval)

Arm definitions are §7 of `docs/research/teammate-like-memory-direction.md`:
**A** = current passive recency index; **B** = deterministic admission-time
retrieval from the existing lexical scorer, bounded to a similarly sized ranked
set, with model-directed memory tools kept.

Points where the external evidence bears directly on that comparison:

1. **B's hypothesis has one supportive measurement and it is narrow.** The
   clearest published number is AgentMemBench: on LoCoMo, where the gold turn is
   many sessions back, ICW, web-augmented, graph and compression strategies
   retrieve almost nothing (Recall@5 ≤ 0.005) while the external key-value store
   reaches 0.573 — i.e. **recency windows collapse at long horizons**
   ([arXiv:2608.00009](https://arxiv.org/abs/2608.00009)). That is a different
   harness and a 7B model, and it measures retrieval, not downstream coding
   outcome. It supports B as a hypothesis; it does not establish B's outcome.
2. **A relevance-based change can regress the correction cases.** STALE's
   premise-resistance result is the failure mode most likely to worsen under a
   similarity-ranked retriever: a stale record that is *semantically near* the
   current query is exactly what similarity ranking promotes
   ([arXiv:2605.06527](https://arxiv.org/abs/2605.06527)). MemOps encodes this as
   recency-top/same-target/stale-value distractors
   ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
3. **Granularity is a design variable inside B, not a detail.** MemOps finds
   session-level retrieval (accuracy 0.845) substantially outperforms turn-level
   retrieval (0.618) with the same retriever, because turn-level fragments lose
   the cross-turn context that update/reflect operations need; managed memory
   that stores long context-rich units beats memory that stores short isolated
   facts ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)). LongMemEval
   similarly reports round-level storage beating session-level, but
   fact-level compression hurting overall accuracy while helping multi-session
   reasoning ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)).
4. **Top-k alone is not the answer.** One paper finds more retrieved chunks
   generally helps ([arXiv:2507.05257](https://arxiv.org/abs/2507.05257));
   another finds the majority-vote/dilution effect hurts
   ([arXiv:2609.16073](https://arxiv.org/abs/2609.16073)); one finds no Mem0 dose
   from 1–5 records beats the memory-off baseline
   ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)). *[Hypothesis]* A/B
   should therefore hold the injected token budget roughly constant and vary the
   selection rule, which is what B's definition already does — measure the
   budget, do not assume B is cheaper.
5. **Intent/task alignment is a better selector than plain similarity in at
   least one setting.** MemGuide's intent-aligned retrieval plus slot-guided
   filtering reports task success 88% → 99% and −2.84 dialogue turns on its own
   MS-TOD benchmark, over "semantic similarity" baselines
   **[Self-reported prototype]** ([arXiv:2505.20231](https://arxiv.org/abs/2505.20231)).
   Method: query-by-intent, not query-by-embedding.
6. **Retrieved ≠ used.** MemCalib exists because models "frequently over-use or
   under-use memory rather than matching each proposition's actual use to its
   target level" ([arXiv:2609.24259](https://arxiv.org/abs/2609.24259)), and
   STALE's adjudication gap shows retrieval visibility without authority
   ([arXiv:2605.06527](https://arxiv.org/abs/2605.06527)). *[Hypothesis]* An A/B
   comparison should log whether an injected memory was actually cited/used in
   the answer, not only whether it was present.

## 5. What this evidence does **not** establish

- **No measured answer to "recency vs task-relevant retrieval" for a coding
  assistant.** No source in §8 compares those two arms prospectively in a repo
  setting. The closest coding results (VibeMemBench, DreamBench-SWE, CTIM-Rover,
  SWE-Bench-CL) are about memory *systems* as wholes, not retrieval policies,
  and are negative, null, or preliminary.
- **No transfer of any specific number** (accuracy, cost, latency) from these
  benchmarks to Term2. Harness, model tier, prompts and budgets all differ, and
  two papers show rankings flipping across configurations.
- **No independent replication** of any cited result; most benchmark author
  groups both define the task and evaluate their own system on it.
- **No evidence that a larger retrieval budget helps**, and none that a smaller
  one is safe.
- **No evidence about the human cost of a review inbox in these benchmarks** —
  the months-scale N=1 record in the teammate-memory note remains the only
  operational evidence on that axis.

## 6. Actionable evaluation checklist

Derived from §1–§4; each item names the source that motivates it.

**Fixture and dependency**

1. Build returning-session cells with at least three sessions: S1 evidence, S2
   reinforcement or revision, S3 task — DreamBench-SWE's shape
   ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).
2. Certify every cell: it must pass with the intended history and fail without
   it, using an executable check where possible — DolphinBench
   ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)). Discard cells with a
   memory-off pass.
3. Include an oracle-retrieval arm (evidence only) so retrieval and reading
   failures are separable — LongMemEval `longmemeval_oracle.json`
   ([repo](https://github.com/xiaowu0162/LongMemEval)).
4. Keep scored answers and fixtures outside anything the agent under test can
   read; verify with a canary. DreamBench-SWE had an adversarial audit invalidate
   its first (non-isolated) run
   ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).

**Probe design**

5. Score at multiple checkpoints per cell, and include an action-style S3 task
   that never names the needed fact — DolphinBench
   ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)).
6. Include explicit-stale, premise-resistance, and implicit-policy probes against
   the same memory — STALE's three dimensions
   ([arXiv:2605.06527](https://arxiv.org/abs/2605.06527)); LongMemEval's
   knowledge-update and abstention types
   ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)).
7. Include an unresolvable-conflict probe: does the agent ask, or does it force
   an answer? — TANGLE's clarification dimension
   ([arXiv:2608.13921](https://arxiv.org/abs/2608.13921)).
8. Score operations, not only answers: did the write happen, bind to the right
   target, and supersede the old value? — HaluMem updating metrics and MemOps
   probe categories ([arXiv:2511.03506](https://arxiv.org/abs/2511.03506),
   [arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).

**Arms and controls**

9. Add an **irrelevant-memory control** at the same token budget as B, not only
   the A baseline — VibeMemBench's control ran 0.7–3.4 points *below*
   memory-off ([arXiv:2609.23570](https://arxiv.org/abs/2609.23570)).
10. Plant recency-salient, same-target and stale-value distractors so "newest or
    nearest" cannot pass — MemOps
    ([arXiv:2607.12893](https://arxiv.org/abs/2607.12893)).
11. Measure and report the injected-token budget per arm; do not assume B is
    cheaper — Total Cost of Agency
    ([arXiv:2609.23790](https://arxiv.org/abs/2609.23790)).
12. Hold the memory store per arm/cell isolated, and record provenance per
    written record (already §7 of the teammate-memory note; motivated by
    poisoning and pollution results there).

**Metrics and analysis**

13. Report **accuracy + total cost + median latency** together — DolphinBench
    makes all three mandatory ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971)).
14. Separate in-path retrieval cost from background/write cost; write is the
    larger observed cost — HaluMem
    ([arXiv:2511.03506](https://arxiv.org/abs/2511.03506)).
15. Prefer deterministic executable checks; if a judge is used, blind it to the
    arm, grade adversarial "topically related but wrong" answers as a calibration
    set, and report judge agreement — DolphinBench's judge caveat and TANGLE's
    r = 0.838 / 85.8%-within-one-point agreement figures
    ([arXiv:2609.24971](https://arxiv.org/abs/2609.24971),
    [arXiv:2608.13921](https://arxiv.org/abs/2608.13921)).
16. Pre-register effect size, sample size and an equivalence margin; do not read
    a null as equivalence, and expect small effects to need more than ~100 cells
    — DreamBench-SWE and VibeMemBench
    ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664),
    [arXiv:2609.23570](https://arxiv.org/abs/2609.23570)).
17. Log whether an injected memory was actually used, and count re-explanations
    and mistaken assumptions explicitly — MemCalib and STALE
    ([arXiv:2609.24259](https://arxiv.org/abs/2609.24259),
    [arXiv:2605.06527](https://arxiv.org/abs/2605.06527)).
18. Re-check collinearity among derived metrics before counting them as separate
    wins — DreamBench-SWE's judge-artifact disclosure
    ([arXiv:2608.20664](https://arxiv.org/abs/2608.20664)).

**First-party product anchors (what shipped systems do, not evidence of value)**

- Anthropic's memory tool is **client-side**: Claude requests file operations
  under `/memories` and the application executes them against storage the
  application controls; "Claude automatically checks its memory directory before
  starting a task," and the docs direct you to pair memory with compaction and to
  enforce path-traversal protection yourself
  ([memory tool docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)).
- Anthropic's context editing clears tool results server-side, which
  **invalidates the cached prompt prefix** at the clearing point; the docs expose
  `clear_at_least` to make the invalidation worth it, and publish no accuracy
  claim for the feature
  ([context editing docs](https://docs.claude.com/en/docs/build-with-claude/context-editing)).
- OpenAI's Agents SDK ships session memory where `SessionSettings(limit=N)`
  retrieves "only the most recent N items" — i.e. **recency is the shipped
  default** — with `CustomSession` existing for custom pruning/reordering, and
  `pop_item` as the documented correction mechanism
  ([Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/)).
  *[Hypothesis]* This is the strongest available argument that arm A is the
  industry default and arm B is the deliberate deviation, so the burden of
  measurement sits on B.

## 7. Bottom line

The evaluation literature has already moved past the single seeded recall
checkpoint: it scores multiple checkpoints, action-style tasks, operation-level
writes, premise resistance, and cost/latency alongside accuracy. What it shows
is that memory systems as currently shipped and published are weak exactly where
arm B claims an improvement — long-horizon recall — and weak exactly where a
naive relevance-retriever could regress — correcting stale state. The evidence
therefore supports running the A/B comparison, and says the comparison should be
judged on correction-sensitive probes, an irrelevant-memory control at matched
token budget, and cost/latency, with pre-registered power. It does not support
predicting the A/B outcome.

## 8. Sources

All fetched and read on 2026-09-25 unless noted.

Primary papers (arXiv abstract and HTML full text):

- LongMemEval — https://arxiv.org/abs/2410.10813
- MemoryAgentBench — https://arxiv.org/abs/2507.05257
- STALE — https://arxiv.org/abs/2605.06527
- HaluMem — https://arxiv.org/abs/2511.03506
- MemOps — https://arxiv.org/abs/2607.12893
- TANGLE (irreducible conflict) — https://arxiv.org/abs/2608.13921
- AgentMemBench — https://arxiv.org/abs/2608.00009
- DreamBench-SWE — https://arxiv.org/abs/2608.20664
- DolphinBench — https://arxiv.org/abs/2609.24971
- VibeMemBench — https://arxiv.org/abs/2609.23570
- MemCalib — https://arxiv.org/abs/2609.24259
- Total Cost of Agency — https://arxiv.org/abs/2609.23790
- The Immutable Past (mutable RAG conflict) — https://arxiv.org/abs/2609.16073
- LongMemEval-V2 — https://arxiv.org/abs/2605.12493
- CTIM-Rover — https://arxiv.org/abs/2505.23422
- SWE-Bench-CL — https://arxiv.org/abs/2507.00014
- MemGuide — https://arxiv.org/abs/2505.20231

Official benchmark repositories and artifacts:

- LongMemEval — https://github.com/xiaowu0162/LongMemEval
- MemoryAgentBench — https://github.com/HUST-AI-HYZ/MemoryAgentBench
- STALE — https://github.com/icedreamc/STALE
- HaluMem — https://github.com/MemTensor/HaluMem (dataset:
  https://huggingface.co/datasets/IAAR-Shanghai/HaluMem)
- DreamBench-SWE (frozen releases) — https://github.com/iroiro147/dreambench-swe
- VibeMemBench —
  https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/VibeMemBench
- MemCalib — https://github.com/Quark-Medical/memcalib
- DolphinBench — https://dolphinbench.ai
- SWE-Bench-CL — https://github.com/thomasjoshi/agents-never-forget

First-party provider documentation:

- Anthropic memory tool —
  https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool
- Anthropic context editing —
  https://docs.claude.com/en/docs/build-with-claude/context-editing
- OpenAI Agents SDK sessions —
  https://openai.github.io/openai-agents-python/sessions/

Referenced inside a cited source but **not read first-hand here** (marked
inline): Penfield Labs' judge-acceptance study (cited in DolphinBench), and the
LoCoMo / MQUAKE / WebArena corpora used as inputs by the benchmarks above. LoCoMo
and the earlier broad review are covered in
`docs/research/teammate-like-memory-direction.md`.
