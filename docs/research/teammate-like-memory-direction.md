# Teammate-like memory: re-evaluating Term2's memory direction against a product goal

Status: **research and decision-support; no implementation committed.** Written
2026-09-24. External claims cite primary sources; every source listed at the end
was fetched and read in this session unless marked otherwise. Findings are
labelled by evidence class, and design hypotheses are marked as hypotheses.

## Why this report exists

`docs/research/active-project-memory-technology.md` (same day) answers a
**technology-first** question: which available systems and indexes could turn
Term2's passive store into an active loop. It concludes, correctly for that
question, that the missing capability is a lifecycle around the existing store,
with SQLite/FTS5 as the recommended first index and vectors/graph/Laya as later
experiments.

This report starts from the **product goal instead of the technology**:

> Over repeated coding sessions, Term2 should feel like a competent human
> teammate: continuity across sessions, accurate understanding of the project,
> it learns the user's corrections, it takes appropriate initiative, and the
> user trusts it — while the incremental model, token, and runtime cost stays
> justified.

Those are different questions. The technology-first report establishes that an
active memory loop is *buildable*. This report asks whether it is *worth
running*, in which form, at what cost, and how to know. It deliberately does not
re-argue the storage choice and does not commit Term2 to a new storage stack or
an implementation roadmap.

### The goal restated as things a user can notice

"Feels like a teammate" is only useful if it decomposes into observable
outcomes. The five goal words map to the following signals, which are also the
things an experiment can measure (definitions in §7):

| Goal word | Observable user outcome | Failure the user feels |
| --- | --- | --- |
| Continuity | The user does not have to re-explain a decision, convention, or correction from an earlier session | "I already told you this" |
| Accurate project understanding | The agent's assumptions about the codebase, conventions, and past decisions match the repo and the user's stated history | Confidently wrong claims; re-discovering known dead ends |
| Learns corrections | A correction given once changes later behavior without repeating it | The same mistake recurs across sessions |
| Appropriate initiative | The agent recalls and acts on relevant prior context without being asked, and asks instead of guessing when it is unsure | Unwanted changes; premature assumptions; or an agent that knows nothing until told |
| Trust | The user can see what the agent believes and why, and can correct or undo it | Silent belief changes; stale "facts" taken as current |

The teammate framing is not decoration. A benchmark that appeared in the same
period states the target directly: *LongMemEval-V2* evaluates "whether memory
systems can help agents acquire the experience needed to become knowledgeable
colleagues in customized environments" [LME-V2]. That is the same goal, so its
results are usable evidence — with the limitation that its environments are web
interfaces, not code repositories (§8).

## Evidence classes used below

- **[Measured]** — a published primary measurement or first-party product
  documentation, read directly.
- **[Vendor-reported]** — a first-party benchmark published by a vendor with a
  commercial interest in the result. Useful for hypothesis generation, not
  independent confirmation.
- **[Term2 code]** — verified by reading Term2's source at commit `65a76cb9`.
- **[Hypothesis]** — a Term2-specific design claim that this report argues for
  but has not measured.

The distinction matters because most public "memory improves X by Y%" numbers
are vendor benchmarks against a full-context baseline, and the strongest
independent result in this area is a *negative* one (§4).

## 1. What the current Term2 memory surface actually does

Read from source; symbols are greppable.

- `MemoryCapabilityBuilder.build()` (`source/services/memory/memory-capabilities.ts`)
  is the single place that resolves memory access, tools, guidance, and injected
  context. The main agent gets `write`; the `librarian` role gets `write`;
  `explorer` and `worker` get `read`; everything else gets `none`.
- The injected context is a **bounded recency index**, rendered by
  `renderMemoryIndex()` (`source/services/memory/memory-store.ts`). It lists the
  newest memories with summaries until a character budget is exhausted, then the
  next ones as titles only, and counts everything it degraded. A memory's age,
  not its relevance to the current request, decides who is summarized.
- The default budget is `memory.contextBudgetChars` = 8000 characters
  (`source/services/settings/settings-schema.ts`), split half-and-half between
  the global and project scopes with slack reallocation
  (`MemoryCapabilityBuilder.build()`).
- The index is composed into the assembled system prompt in `agent.ts`
  (`prompt = ... + memoryCapability.context`), built with the synchronous
  `contextSync()` read. It is a **prompt-composition input**, not a per-request
  retrieval step.
- `scoreMemorySearch()` (`source/services/memory/memory-search.ts`) ranks
  candidates with weighted substring matching over id, title, tags, summary, and
  content. It is deterministic, local, and needs no model.
- Retrieval happens only because the model chooses to call a tool. The prompt
  guidance (`MAIN_GUIDANCE`, and the `memory.md` fragment) tells the model to
  retrieve "when it could materially improve correctness" and to review durable
  learnings before finishing a task. Both are instructions, not mechanism.
- Writes are model-discretionary and forward-only: `create`/`update`/`delete`
  exist, but a superseded fact is overwritten rather than retained with history.

**What is therefore missing relative to the goal: [Term2 code]**

1. No retrieval tied to the current task: the same 8000-character recency index
   is present in every request of a session, whether or not it is relevant.
2. No lifecycle trigger: nothing reflects, consolidates, or revalidates at any
   boundary. The rollover brief (`composeSessionRolloverBrief()` in
   `source/services/session-rollover/session-rollover-brief.ts`) is a
   model-authored handoff string, not an update to memory.
3. No provenance or staleness state, so "learns corrections" depends on the
   model noticing a correction and choosing to overwrite the right record.
4. No receipt for *injection*: a tool call renders as "Retrieved memory" /
   "Saved memory" (`source/components/message/CommandMessage.tsx`), but memory
   silently present in the prompt is invisible to the user.
5. No memory-quality fixtures: memory is covered by unit tests
   (`memory-store.test.ts`, `memory-search.ts` via `memory-capabilities.test.ts`,
   `memory-tools.test.ts`) but there is no `eval/` fixture that measures whether
   memory helps a returning session.

Point 5 is the load-bearing one for this report. The current design cannot fail
loudly, because nothing measures whether it works.

## 2. Where passive memory falls short, stated as failure modes

The failure modes below are each backed by external evidence that the mechanism
is real, not hypothetical.

### 2.1 Recency is not relevance

The injected index is a recency list. But at scale, retention-by-age does not
bound the cost or the noise of a memory working set: **AMV-L [Measured]** treats
agent memory as a managed resource and reports that age-based TTL "does not
bound the computational footprint of memory on the request path," producing
heavy-tailed latency; bounding the retrieval *working set* removed 13.8% → 0.007%
of requests exceeding 2 s, and the gains "arise primarily from bounding
retrieval-set size and vector-search work, not from shortening prompts."

Term2 at single-user scale is nowhere near that latency regime. The transferable
point is smaller and still true: a recency index spends its budget on *recent*
memory, so an old-but-central convention is summarized last, after newer trivia.

### 2.2 More retrieved context can make the agent worse

Two independent results say retrieval is not monotonically good:

- **CTIM-Rover [Measured]** added repository-level cross-task episodic memory to
  a working SWE agent and found that "CTIM-Rover does not outperform
  AutoCodeRover in any configuration," attributing the result to "noise
  introduced by distracting CTIM items or exemplar trajectories."
- **Chroma context rot [Measured]** shows model performance "grows increasingly
  unreliable as input length grows," that degradation is worse when the
  question-needle similarity is low, and that distractors and even logical
  coherence of the haystack reduce accuracy. In a code agent, prior-session
  context that is *similar but not the situation at hand* is exactly this kind
  of distractor.

This is the strongest argument against "inject everything and let the model
sort it out," and it applies directly to a recency index.

### 2.3 Multi-turn sessions already lose information without any memory system

**"LLMs Get Lost in Multi-Turn Conversation" [Measured]** ran 200,000+ simulated
conversations across six generation tasks and found an average **39% performance
drop** in multi-turn vs single-turn settings, decomposing into "a minor loss in
aptitude and a significant increase in unreliability," with models that "make
assumptions in early turns and prematurely attempt to generate final solutions,
on which they overly rely." **Lost in the Middle [Measured]** independently
shows that relevant information is used worst when it sits in the middle of a
long context.

Together these say the *intra-session* problem the user experiences as
"re-explaining" is partly a context-usage problem, not only a persistence
problem. A memory system that fixes persistence but floods the context can make
this worse.

### 2.4 Long-term memory is measurably hard, and nobody has a solved answer

- **LongMemEval [Measured]** defines five abilities — information extraction,
  multi-session reasoning, temporal reasoning, knowledge updates, abstention —
  and reports that "commercial chat assistants and long-context LLMs [show] a
  30% accuracy drop on memorizing information across sustained interactions."
  Note *knowledge updates* and *abstention*: the two abilities most tied to
  corrections and to not asserting stale facts.
- **LoCoMo [Measured]** generated very long-term dialogues (up to 35 sessions,
  ~300 turns, ~9K tokens each) and concluded that long-context LLMs and RAG
  "still substantially lag behind human performance."

These bound expectations. A competent-teammate feel is a research-grade
target; the honest posture is measurement, not confidence.

## 3. When a bounded background memory agent genuinely helps

The task's framing — background agent versus simpler on-task extraction and
local retrieval — is answerable if we ask *where the needed knowledge lives*:

| Knowledge location | Example | Best mechanism |
| --- | --- | --- |
| (a) In the current context / repo — verifiable now | Architecture, current file contents, test results, git history | Plain on-task work: read the file, run the test, `git log`. No memory, no background agent. |
| (b) In durable artifacts, findable on demand | Prior sessions, decisions recorded in commits, PR/commit messages | Local retrieval over existing artifacts (`session_search`/`session_read` via `source/tools/session-browser/session-browser-tools.ts`, or the `librarian` role). Background agent adds little. |
| (c) Only in the interaction history, not written anywhere durable | "We tried X and rejected it because Y"; a user preference; a correction | This is the gap. On-task extraction catches it *if* the model writes it down while the turn is live; a bounded background reflection catches it *later* at a boundary. |

The evidence supports a narrow, specific role for a background agent:

- **Agentic gathering beats RAG when evidence is spread across long
  trajectories, at a latency cost. [Measured]** In LME-V2, a coding-agent-based
  memory that "stores trajectories as files and invokes a coding agent to gather
  evidence in an augmented sandbox" reached **72.5%** average accuracy versus
  **48.5%** for the strongest RAG baseline (and 69.3% for an off-the-shelf coding
  agent). The paper is explicit that "coding agent based methods have high
  latency costs." That is the trade: more accuracy for more compute and
  wall-clock, on questions whose evidence is scattered.
- **Background precomputation pays off only when the future query is
  predictable. [Measured]** **Sleep-time compute** precomputes over a context
  before queries arrive; it "can reduce the amount of test-time compute needed
  to achieve the same accuracy by ~5x" on two stateful reasoning tasks, and
  "amortizing sleep-time compute across related queries about the same context
  ... decrease[s] the average cost per query by 2.5x." The paper's own caveat is
  the decision rule: "the predictability of the user query [is] well correlated
  with the efficacy of sleep-time compute." A coding session is a *related-query*
  setting (many questions about one evolving context), which is the favorable
  case; a nightly run over an idle repo with no new transcript is not.

### 3.0 The distinction that decides it

A background memory agent is worth testing when **all** hold:

1. the knowledge is class (c) — present in interaction history and not
   recoverable by reading the repo;
2. the extraction is **delayed but bounded** — triggered by a meaningful
   boundary, not by a clock;
3. its output is verifiable or reviewable before it becomes durable belief;
4. the cost of the pass is small relative to what it prevents (§6).

If (1) fails, local retrieval or a plain file read wins. If (2) fails, it is
"always running" and §5 applies. If (3) fails, §4 applies.

One external precedent for (3): **MemCoder [Measured — self-reported
preprint]** distills intent from past commits and uses "verification feedback to
correct agent behavior," crystallizing only "human-validated solutions into
long-term knowledge," reporting a 9.4% resolved-rate improvement over a
foundation-model baseline on SWE-bench Verified. The mechanism to copy is the
*validation gate on what becomes durable*, not the specific pipeline.

## 4. Privacy, trust, correction, and stale memory

This section is where a memory feature most plausibly destroys trust rather than
building it, and the evidence is blunt.

### 4.1 A small amount of false durable memory is catastrophic

**"Utility Under Attack" [Measured]** poisons 1.2% of a LongMemEval corpus with
plainly-worded false assertions and drops accuracy from **0.850 to 0.300**. A
four-stage write-time screening pipeline that reached 0.832 recall on indirect
prompt injection "rejects 0 of 360 poisoned memories." Retrieval-time provenance
weighting fared no better: the shipped weight was "statistically
indistinguishable from no defense (p=0.80)," and a stronger weight "recovers
utility only by excluding untrusted content," collapsing to 0.0417 accuracy when
the answer-bearing evidence is itself untrusted. The authors conclude that
distinguishing false from true "generally requires external grounding beyond the
text itself."

The design consequence is concrete and cheap: **prefer bounded occupancy at
retrieval (a cap on how much unverified memory may enter a request) and
grounding over additive trust scores**, and require provenance for anything that
can steer behavior.

### 4.2 Background execution is a memory-pollution channel

**"Mind Your HEARTBEAT" [Measured]** identifies a vulnerability that is not a
prompt injection: because heartbeat background execution "runs in the same
session as user-facing conversation," untrusted content encountered in the
background enters the same memory context, and "routine memory-saving behavior
can promote short-term pollution into durable long-term memory at rates up to
91%, with cross-session behavioral influence reaching 76%." Pollution crossed
session boundaries even under content dilution and context pruning. No injection
was required; ordinary misinformation sufficed.

For Term2 this is not academic. Term2 already runs background subagents and has
a per-task check-in scheduler
(`source/services/session/background-check-in-scheduler.ts`). A background
memory agent that shares the foreground session, or that writes without
provenance, is the exact shape the paper warns about. The mitigations the paper
implies — separate provenance, bounded promotion, and visibility — are the same
ones §4.1 implies.

**"Context manipulation attacks" [Measured]** reinforces it from the other
direction: corrupting an agent's memory with "plan injection" achieved "up to 3x
higher attack success rates than comparable prompt-based attacks," with
context-chained variants adding 17.7% success on exfiltration tasks.

### 4.3 Stale memory and corrections

Two mechanisms make "stale" a first-class state rather than an edge case:

- Term2's store overwrites on update (`update()` in `memory-store.ts`), so a
  superseded fact leaves no history and cannot be distinguished from a current
  one. The prior technology report already recommends bitemporal/supersession
  semantics borrowed from Graphiti (cited there); this report adds only that the
  *user-facing* consequence — an agent confidently citing a fact the user
  replaced — is an ability LongMemEval explicitly tests (knowledge updates).
- **Mem0's documented algorithm is ADD-only [Vendor-reported]**: changed facts
  coexist rather than being overwritten, which "preserv[es] history but mak[es]
  knowledge-update ranking a harder retrieval problem" (quoted from the prior
  report's analysis of Mem0). Correction handling is therefore not free in any
  architecture; it is a retrieval problem either way.

Term2's existing guidance already says the right thing — "current user
instructions and the live repository state take precedence" (`MAIN_GUIDANCE`)
— and the librarian instructions already require citing source IDs. What is
missing is enforcement and visibility, not instruction.

### 4.4 The trust posture this implies

1. **Explicit, durable user rules** ("always use pnpm in this repo") may become
   active immediately with an undo receipt only when grounded in an actual
   user-authored instruction. Quotes, tool output, or repository content that
   merely *claim* to be user instructions are not enough.
2. **Inferred or repository-derived claims** are candidates until a cited source
   is checked; they must not silently steer behavior.
3. **Every durable record carries provenance** (session id and, where relevant,
   a commit/blob or file anchor), so a stale record can be revalidated rather
   than merely age out.
4. **Retrieval applies a bounded occupancy cap** on unverified memory, per §4.1.
5. **A background reflection run never shares the foreground session's context
   or memory-write tools**; it returns proposals to the owner for review and
   promotion, per §4.2.

## 5. Does "always running" add value, or only expense?

**Conclusion: periodic model calls without new evidence are the wrong default.**
An idle agent process need not incur token charges; the expense and risk come
from repeated reflection calls, not from remaining available to run. Boundary
triggers can capture the same new evidence without paying to reread it on a
clock. This distinction is falsifiable and cheap to test.

Three independent arguments:

1. **Repeated work needs a measured payoff.** A second pass over unchanged
   context might uncover a useful insight, but it has no new transcript
   evidence. Sleep-time compute's own finding is that its efficacy tracks query
   predictability and that the win comes from *amortizing across related
   queries* — i.e., from precomputing for queries that will actually arrive.
   Periodic execution spends tokens whether or not a related query arrives;
   its incremental value must be measured against one boundary-triggered pass.
2. **Clock-triggered cost scales with wall-clock, not with work.** A reflection
   pass costs roughly what the agent spends reading one additional ~30k-token
   chunk at the stated uncached rates (§6). Running hourly is ~24 passes/day regardless of whether
   the user wrote code that day.
3. **Risk scales with exposure.** Every background pass is an ingestion and
   promotion opportunity. HEARTBEAT's pollution rates (§4.2) are highest exactly
   in continuous background execution.

What *does* justify background work is a **trigger set**, each of which is a
moment when new durable evidence exists and the user is not waiting:

- after a completed task with tool activity and settled work;
- after an explicit user correction (highest-value class);
- at a rollover / compaction boundary (Term2 already detects both);
- after N settled turns, debounced.

Letta Code's shipped "dreaming" feature is a direct product precedent for the
trigger set rather than a clock: it runs background subagents "after a set
number of completed agent steps or when the context window is compacted," with
an optional second review pass before updates apply [Letta memory]. That is the
same boundary-triggered shape proposed here, and it is noteworthy that even a
stateful-agent product chose boundaries over continuous execution.

The disanalogy to test: Term2 could be run "always" in the sense of *a process
that is always available to be triggered*, which is different from *repeated
model calls on a timer*. The former can be nearly free while idle; it is the
latter that needs a measured benefit.

**Conditions that would reverse this conclusion** (state them before running the
experiment so the result is falsifiable): the measure of predictability is high
*and* multiple concurrent consumers reuse the same precomputed context *and*
measured query rate is high enough that idle passes are rare. None of those are
true by assumption for a single-user CLI, and the experiment in §7 can falsify
the default.

## 6. Actual cost drivers, with transparent arithmetic

All prices below are from the vendors' published pricing pages **as read on
2026-09-24** [OpenAI pricing][Anthropic pricing]. Token counts are stated
assumptions, not measurements. Nothing here should be read as a measured saving.

### 6.1 Published price anchors used

| Model | Input /MTok | Cached input /MTok | Cache write /MTok | Output /MTok |
| --- | ---: | ---: | ---: | ---: |
| `gpt-6-luna` (cheap tier) | $0.10 | $0.01 | $0.125 | $0.50 |
| `gpt-6-sol` (mid tier) | $2.00 | $0.20 | $2.50 | $10.00 |
| Claude Haiku 4.5 | $1.00 | $0.10 (read) | $1.25 (5-min) | $5.00 |
| Claude Sonnet 5 | $2.00 | $0.20 (read) | $2.50 (5-min) | $10.00 |

Mechanisms that move these numbers:

- **Caching.** OpenAI's cached-input rate is "discounted up to 90%" and reuse is
  by longest-matching prefix, with a minimum cacheable length of 1,024 tokens for
  GPT-5.6+ and a retention default of ~5–10 minutes inactive up to one hour (a
  24 h option exists) [OpenAI prompt caching]. Anthropic charges cache writes at
  **1.25x** input for a 5-minute cache and **2x** for a 1-hour cache, and reads
  at **0.1x** (with 0.025x/0.05x exceptions on some models), with minimum
  cacheable lengths of 512–4,096 tokens depending on model [Anthropic prompt
  caching]. Google's Gemini API enables implicit caching by default on 2.5+
  models [Gemini context caching].
- **Batch.** OpenAI's Batch API is "50% cost discount compared to synchronous
  APIs" with a 24-hour turnaround [OpenAI batch]; Anthropic's Message Batches is
  a 50% cut with "most batches finishing in less than 1 hour" [Anthropic batch].

### 6.2 One reflection pass, three tiers

Assumptions: **20,000 input tokens** (settled transcript delta + candidate
memories + instructions), **2,000 output tokens** (structured operations).

- `gpt-6-luna`: 20k × $0.10/1e6 = **$0.0020** + 2k × $0.50/1e6 = **$0.0010** →
  **$0.0030/pass**
- Claude Haiku 4.5: 20k × $1.00/1e6 = **$0.0200** + 2k × $5.00/1e6 = **$0.0100**
  → **$0.0300/pass**
- `gpt-6-sol` / Claude Sonnet 5: 20k × $2.00/1e6 = **$0.0400** + 2k ×
  $10.00/1e6 = **$0.0200** → **$0.0600/pass**

Two observations fall out of the arithmetic:

- **Output is expensive per token** (5x input price), but input still accounts
  for two-thirds of the example pass cost at a 20k:2k token mix. Bound both
  transcript input and structured-operation output; measure their actual mix.
- **Model tier spans 20x** ($0.0030 → $0.0600) for identical work. Model choice
  and trigger frequency both matter; neither is a substitute for measuring
  whether the pass helps.

**Cost-equivalence anchor (model-agnostic, uncached rates).** At these 5:1
output-to-input price ratios, 20k input plus 2k output costs about the same as
**30k additional input tokens** on the same tier. This is not a break-even
claim: avoiding that many input tokens would still have to produce a useful
outcome, and cache hits, model choice, and different request shapes change the
comparison.
That is the honest scale of the cost: it is *not* free, and it is *not*
catastrophic. It is roughly "one extra medium read per trigger" at the stated
uncached rates.

Where the chosen model and API support the cited batch discount, an eligible
uncached pass can cost about half as much; compare the resulting latency and
cache behavior before choosing it for end-of-day consolidation.

### 6.3 Frequency, the thing "always running" changes

Monthly cost at 30 days, using the per-pass figures above:

| Passes/day | `gpt-6-luna` | Haiku 4.5 | `gpt-6-sol`/Sonnet 5 |
| ---: | ---: | ---: | ---: |
| 4 (several completed tasks/day) | $0.36 | $3.60 | $7.20 |
| 8 (a working day) | $0.72 | $7.20 | $14.40 |
| 24 (always running, hourly) | $2.16 | $21.60 | $43.20 |

The bottom row is the hourly-reflection example. On the cheap tier it is
~$2/month and arguably tolerable; on the mid tier it is $43/month for passes that, per
§5, mostly have no new evidence to process. The decision is therefore not "can we
afford it" but "does the marginal pass produce anything," and the published
sleep-time-compute analysis says it produces something only when queries are
predictable and amortizable.

### 6.4 The injection tax (and a caching interaction worth measuring)

The recency index is present in *every* request of a session. At the default
8,000 characters it is roughly **2,000 tokens** (≈4 chars/token). Per request:

| Tier | Uncached (2k tok) | Cached (0.1x) |
| --- | ---: | ---: |
| `gpt-6-luna` | $0.0002 | $0.00002 |
| `gpt-6-sol` / Sonnet 5 / Haiku 4.5 | $0.004 / $0.004 / $0.002 | $0.0004 / $0.0004 / $0.0002 |
| `gpt-6-astra` (frontier) | $0.020 | $0.0020 |

At 9,000 requests/month that is $1.80/month on the cheap tier, $36/month on the
mid tier, $180/month on the frontier tier **if every request incurs the full
uncached cost** — *for injecting memory whether or not it is relevant*. Real
usage must measure cache hits and actual index size rather than adopting these
upper-bound examples as bills. **[Hypothesis]** A related mechanism deserves measurement rather
than assumption: caching reuses a *prefix*, so inserting dynamically-retrieved
memories early in the prompt breaks reuse of everything after the insertion
point, while inserting them after the stable prefix preserves it. Admission-time
retrieval therefore has a caching cost the naive calculation misses, and where
the retrieved block is placed is a first-class design variable, not a detail.

### 6.5 Latency

- **In-path extraction** adds a serial model round trip to the turn that
  triggered it. In Term2 terms this is the difference between the user waiting
  for the assistant and the assistant finishing.
- **Background reflection** avoids an additional serial request on the user's
  critical path, though provider contention or a late result can still delay
  useful memory for the next task; it also consumes a slot and, if not isolated,
  adds pollution risk
  (§4.2).
- Retrieval *quality* also has a latency cost at scale: LME-V2's best variant is
  the slowest [LME-V2], and AMV-L's whole thesis is that an unbounded retrieval
  working set creates tail latency [AMV-L]. Term2 is far from those scales, but
  the experiment should record p95 anyway so the ceiling is known before it is
  hit.

### 6.6 Human cost, which is usually the real budget

Every candidate memory is something the user may have to judge. **"Memory as
Infrastructure" [Measured — N=1]** is the only months-scale operational record
found (a 633k-line codebase, a single continuous session line since January
2026, memory instrumented since July 2026): 78,933 hook invocations, "85 recorded
failures, none silent," "an injection layer whose ten-day precision instrument
shows zero false fires against an intact denominator," and — the transferable
part — reliability engineering for the memory subsystem itself, including
"alert-fatigue budgeting borrowed from SRE practice." Its stated limitation is
honest and applies to any lesson drawn from it: N=1, no control arm,
self-reported. The design takeaway is that **precision, not recall, is the
budget that runs out**, and that a review inbox with no budget becomes noise.

### 6.7 Measurement plan (instrument before changing behavior)

The cost claims above are arithmetic on stated assumptions. Turning them into
measured facts is a prerequisite for the experiment, and Term2 already has most
of the plumbing:

1. **Log, do not change, for one baseline period.** Emit structured events for:
   admission-time retrieval candidates and selections (once implemented; the
   baseline has none), every memory tool call, injected index size in tokens,
   reflection runs with input/output tokens, and applied/rejected operations.
   Reuse the logging and provider-traffic surfaces; follow the accounting method
   in `docs/research/context-lifecycle-economics.md` (deduplicate by request id,
   emit no prompt content).
2. **Define guardrails with thresholds before the experiment:** injection
   precision (false-fire rate), candidate acceptance rate, review items per
   session, incremental $ per session, added p95 latency.
3. **Publish the arithmetic above as the pre-registered cost model**, so a
   result that beats or misses it is visible rather than rationalized. The
   N=1 operational record's "tagged pre-registered ablation protocol" is the
   right genre [Memory as Infrastructure].

## 7. A minimal experiment

**Hypothesis H1:** a bounded admission-time retrieval step plus a
review-gated, boundary-triggered reflection pass reduces re-explanation and
mistaken assumptions across returning sessions, without regressing task
acceptance, at an incremental cost and latency inside a stated budget.

### 7.1 Design

Three arms, same repeated-session task cells:

| Arm | Memory behaviour | What it tests |
| --- | --- | --- |
| **A — control** | Current passive memory (recency index + model-directed tools) | Baseline |
| **B — retrieval only** | A: replace the recency index with deterministic admission-time retrieval from the existing lexical scorer, bounded to a similarly sized ranked set with stable IDs; keep model-directed memory tools | Whether relevance beats recency without an extra model call; prompt-token and cache costs still count |
| **C — retrieval + bounded reflection** | B: plus a debounced, boundary-triggered reflection pass returning structured `create/update/supersede/ignore` operations, applied only after the owner validates them | Whether the background agent adds anything beyond B |

Arm B is the load-bearing arm. If B closes the gap, the background agent's
justification fails, and that is a *good* result for a cost-justified feature.

**Unit:** a "returning-session cell" — one task deliberately split across ≥3
sessions, containing (i) a durable project decision, (ii) a correction the user
issues mid-way, and (iii) a dead-end the user should not be sent back into.
Fixtures do not exist today; building them is the first work item.
Use isolated copies of the memory store per arm/cell so C's writes cannot leak
into A or B, and hold model/provider, task materials, and allowable context
budget constant. Measure any change in prompt-token and cache cost rather than
assuming B is free because it makes no additional model call.

**Triggers for C** (not a clock): completed task with settled tool activity,
explicit correction, rollover, compaction, and N settled turns — debounced.

**Isolation requirement:** C's writer must not share the foreground session's
context, and every operation must carry provenance (session id; commit/blob or
file anchor where applicable) per §4.

### 7.2 Metrics

1. **Re-explanation count** per cell — the user restates a fact, decision, or
   correction they already gave in an earlier session.
2. **Mistaken-assumption events** per cell — the agent asserts something
   contradicted by memory, the repo, or a prior decision.
3. **Returning-session quality** — task acceptance, and (secondary) a blind
   judge comparing A/B/C transcripts without knowing the arm.
4. **Incremental cost** — input/output tokens and $ per cell and per session,
   against the §6.3 model.
5. **Incremental latency** — added wall-clock, p50/p95, split into in-path
   (B's retrieval) and off-path (C's reflection).
6. **Write precision** — fraction of applied operations judged durable and true
   on later review (guardrail, per §6.6).
7. **Review burden** — candidate operations surfaced per session.

### 7.3 Success / failure / stop criteria (pre-registered)

- **Success for C:** C improves on B in re-explanation or mistaken-assumption
  events without worsening the other, task acceptance, or pre-registered cost,
  latency, write-precision, and review-burden limits. A–B separately measures
  whether retrieval alone helps. Set numeric thresholds and the incremental
  dollars the user is willing to spend per avoided re-explanation or corrected
  mistake using the baseline before examining arm results; the §6 arithmetic
  is a cost estimate, not a value threshold.
- **Failure:** no measurable reduction in re-explanation or mistaken assumptions
  in C over A; or acceptance regresses; or added in-path latency exceeds budget;
  or incremental cost exceeds the budget with no quality gain.
- **Stop / pivot:**
  - B meets the pre-registered user-outcome target, and C adds no worthwhile
    incremental improvement within its cost and review budget → **do not ship
    the background agent** for this goal; keep retrieval and revisit only if
    new evidence appears.
  - Applied-write precision below the floor → reflection stays propose-only
    (never auto-apply).
  - Any pollution or untrusted-content-influenced write observed → **disable the
    background writer** and treat it as a design failure, per §4.2.
  - Review burden above budget → narrow triggers; drop inferred writes before
    dropping explicit-rule capture.
- **Kill condition for "always running":** if hourly passes with no new
  transcript produce no accepted operations across the trial, the always-on
  variant is falsified for this workload (§5) and should not be offered.

## 8. Viable approaches compared

| Approach | When it wins | Added runtime | Trust risk | Latency | Fit to Term2 |
| --- | --- | --- | --- | --- | --- |
| **A. Status quo (passive)** | A memory feature has no demonstrated incremental benefit | None | Existing staleness and write risk | None | Present |
| **B. On-task extraction only** (agent writes while the turn is live) | Class (c) knowledge is noticed in the moment | None beyond the turn | Low–medium (write precision unmeasured) | None extra | Supported by existing tools; needs a write-precision gate |
| **C. Deterministic admission-time retrieval** (existing lexical scorer; optional index later) | Knowledge is in the store and the query shares vocabulary | None | Low (no new writer) | Small in-path step | Fits the existing store; no new storage stack required |
| **D. C + bounded, review-gated reflection** | Knowledge is class (c) and surfaces only at a boundary | One scheduled pass per trigger | Medium unless review-gated and isolated | Off-path | Reuses the existing subagent/background machinery and `librarian` API |
| **E. Always-running background agent** | Only if query predictability and query rate are both high (§5) | Continuous | **High** (§4.2) | Off-path, but continuous | Not justified by this evidence |
| **F. External memory engine** (Letta/Mem0/Zep as the core) | A team wants a managed memory platform and accepts a second runtime | A second stateful system | Depends; see §4.1 on provenance limits | Vendor claims vs full-context (Mem0: 91% lower p95 latency; Zep: 90% latency reduction) | Couples Term2's provider-neutral loop to a competing platform; the prior technology report already argues against it |

Candidate shape, *only if the experiment justifies it*: **C + D**, with B kept
as the no-extra-background-run default for explicit corrections. Vector/graph indexes and
external engines stay out of scope for this goal until the experiment shows a
retrieval-quality gap that the existing scorer cannot close — which is a
measurement, not a preference.

## 9. Evidence limitations and what would change the conclusion

- **The single best months-scale evidence is N=1, no control arm, self-reported**
  [Memory as Infrastructure]. It is operationally informative and statistically
  weak.
- **Most "memory helps" numbers are vendor benchmarks** (Mem0, Zep) against
  full-context baselines, or graph/vector variants of the vendor's own system.
  They show the mechanism is real; they do not show it generalizes to Term2.
- **The strongest independent result found is negative** (CTIM-Rover: no
  configuration beat the memoryless baseline) and the strongest security results
  are negative too (screening fails; provenance weighting has no usable
  setting). The report is weighted accordingly.
- **LME-V2 is a web-environment benchmark, not a code benchmark.** Its
  agentic-vs-RAG gap is the closest available analogue to a repo memory agent,
  and it should be treated as a directional signal, not a Term2 number.
- **No Term2 measurement exists** of how often the current memory is consulted,
  how often retrieved memory changes a decision, or how often the user
  re-explains. This is the largest gap and the cheapest to close (§6.7).
- **Token assumptions in §6 are stated per-run, not measured.** If the real
  reflection window is not ~20k tokens, every figure scales linearly; the
  sensitivity table, not any single cell, is the finding.

**What would overturn the recommendation:** (i) arm B failing to close any gap,
which would strengthen the case for agentic gathering; (ii) a measured
predictability/query-rate profile that makes idle passes rare, which would
rehabilitate "always running"; (iii) explicit-rule capture alone failing to
reduce re-explanation, which would mean the problem is context usage
(§2.3) rather than persistence.

## Sources

Primary sources fetched and read for this report (2026-09-24):

- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)
- [LongMemEval-V2: Evaluating Long-Term Agent Memory Toward Experienced Colleagues](https://arxiv.org/abs/2605.12493)
- [Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo)](https://arxiv.org/abs/2402.17753)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [Sleep-time Compute: Beyond Inference Scaling at Test-time](https://arxiv.org/abs/2504.13171)
- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110)
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)
- [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120)
- [From Knowledge to Noise: CTIM-Rover and the Pitfalls of Episodic Memory in Software Engineering Agents](https://arxiv.org/abs/2505.23422)
- [Your Code Agent Can Grow Alongside You with Structured Memory (MemCoder)](https://arxiv.org/abs/2603.13258)
- [Mind Your HEARTBEAT! Claw Background Execution Inherently Enables Silent Memory Pollution](https://arxiv.org/abs/2603.23064)
- [Utility Under Attack: Agent Memory Poisoning and the Limits of Content Screening and Provenance Ranking](https://arxiv.org/abs/2608.21230)
- [Memory as Infrastructure: Reliability Engineering for Persistent Agent Memory in Months-Long LLM-Assisted Development](https://arxiv.org/abs/2609.05510)
- [AMV-L: Lifecycle-Managed Agent Memory for Tail-Latency Control in Long-Running LLM Systems](https://arxiv.org/abs/2603.04443)
- [SuperLocalMemory V3.3: Biologically-Inspired Forgetting, Cognitive Quantization, and Multi-Channel Retrieval for Zero-LLM Agent Memory Systems](https://arxiv.org/abs/2604.04514)
- [Context manipulation attacks: Web agents are susceptible to corrupted memory](https://arxiv.org/abs/2506.17318)
- [Memory Management and Contextual Consistency for Long-Running Low-Code Agents](https://arxiv.org/abs/2509.25250)
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance (Chroma technical report)](https://research.trychroma.com/context-rot)
- [OpenAI — Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [OpenAI — Pricing](https://platform.openai.com/docs/pricing)
- [OpenAI — Batch API](https://platform.openai.com/docs/guides/batch)
- [Anthropic — Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic — Pricing](https://www.anthropic.com/pricing)
- [Anthropic — Batch processing](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing)
- [Google — Gemini API context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Letta — Memory & dreaming](https://docs.letta.com/letta-code/memory)

Reference links used in the findings and cost arithmetic:

[LME-V2]: https://arxiv.org/abs/2605.12493
[AMV-L]: https://arxiv.org/abs/2603.04443
[Memory as Infrastructure]: https://arxiv.org/abs/2609.05510
[OpenAI pricing]: https://platform.openai.com/docs/pricing
[Anthropic pricing]: https://www.anthropic.com/pricing
[OpenAI prompt caching]: https://platform.openai.com/docs/guides/prompt-caching
[Anthropic prompt caching]: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
[Gemini context caching]: https://ai.google.dev/gemini-api/docs/caching
[OpenAI batch]: https://platform.openai.com/docs/guides/batch
[Anthropic batch]: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
[Letta memory]: https://docs.letta.com/letta-code/memory

Referenced but not re-fetched here (covered in
`docs/research/active-project-memory-technology.md`): MemFS, LangMem, Graphiti,
`sqlite-vec`, Tree-sitter, Laya.

Term2 anchors read at commit `65a76cb9`:
`source/services/memory/memory-capabilities.ts`,
`source/services/memory/memory-store.ts`,
`source/services/memory/memory-search.ts`,
`source/tools/memory/memory-tools.ts`,
`source/agent.ts`,
`source/services/settings/settings-schema.ts`,
`source/services/session-rollover/session-rollover-brief.ts`,
`source/services/session/background-check-in-scheduler.ts`,
`source/tools/agent/run-subagent-async.ts`,
`source/tools/session-browser/session-browser-tools.ts`,
`source/components/message/CommandMessage.tsx`,
`docs/plans/memory_feature.md`,
`docs/research/context-lifecycle-economics.md`.

## Decision

Optimize for the teammate outcome, not for a memory architecture. In order:
**(1)** build the returning-session fixtures and instrument the baseline, because
nothing today can tell whether memory helps; **(2)** add deterministic
admission-time retrieval over the existing store (arm B) and measure; **(3)** add
a bounded, boundary-triggered, review-gated reflection pass (arm C) only if B
leaves a gap. Do **not** default to an always-running background agent: the
evidence says its cost scales with wall-clock while its benefit scales with
query predictability, and its risk scales with background exposure. Do not commit
a new storage stack; the open decision is trigger design, provenance, and a
precision budget, and those are measurable.
