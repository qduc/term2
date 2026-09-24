# Active project memory — available technology and Term2 fit

Status: **research complete; implementation not started.** Researched
2026-09-24 against primary documentation, source repositories, model cards,
and papers. Product benchmark numbers below are first-party unless explicitly
described otherwise; they are useful for selecting experiments, not proof of
Term2-specific quality.

## Question

What technology available now can turn Term2's existing passive persistent
memory into a visible loop in which the assistant recalls relevant project
knowledge, learns from completed work, preserves provenance, detects likely
staleness, and lets the user inspect or undo what changed?

## Executive conclusion

No external system should replace Term2's memory store for the first slice.
The missing capability is an **active lifecycle around the store**, not a new
database:

1. retrieve relevant project memories automatically at task admission;
2. reflect after meaningful work at an idle boundary;
3. stage inferred memories for review while auto-saving explicit user rules;
4. record source provenance and supersession rather than overwriting history;
5. show small "used" and "learned" receipts in the TUI.

The strongest available precedent is Letta Code's `/init`, `/remember`,
`/doctor`, and background "dreaming" workflow. The closest reusable workflow
design is LangMem's delayed background manager. Mem0 and Graphiti demonstrate
useful hybrid-retrieval and temporal-data patterns, but adopting either as
Term2's core memory engine would add a second runtime and storage architecture.

For local retrieval, Term2 can use technology it already ships:
`better-sqlite3` and SQLite FTS5. A rebuildable SQLite sidecar can index the
current file-backed memories without sacrificing inspectability. Semantic
retrieval can be added later with `sqlite-vec` plus a local embedding model,
after a Term2-specific retrieval evaluation demonstrates that FTS5 misses
material queries.

Laya is relevant, but it is **not a memory engine**. It is a fixed-answer
decision model. It may eventually make a fast, local reflection gate or memory
classifier after domain fine-tuning; it cannot write a memory, retrieve one,
resolve contradictions, or verify source provenance by itself.

## Current Term2 baseline

The live implementation already has the hard ownership primitives:

- `MemoryCapabilityBuilder` resolves global and project scopes, injects a
  bounded recency index, and grants the main agent read/write memory tools.
- `FileMemoryStore` persists records with `id`, `title`, `summary`, `content`,
  `tags`, `createdAt`, and `updatedAt`.
- `scoreMemorySearch()` performs deterministic weighted lexical matching over
  identifiers, titles, tags, summaries, and content.
- The main-agent prompt asks the model to retrieve memory when relevant and to
  review durable learnings before finishing a task.

That makes memory model-directed and therefore passive: there is no lifecycle
trigger, candidate inbox, provenance model, staleness state, or user-visible
receipt. Retrieval depends on the model acting on an injected index or calling
a memory tool.

Term2 also already ships `better-sqlite3`. `SessionIndexDatabase` uses it with
WAL and an FTS5 capability probe, so adding a separate derived memory index does
not require introducing SQLite as a new deployment technology.

## Available systems and what they contribute

### Letta Code and MemFS: the closest product precedent

Letta Code is a TypeScript terminal agent under Apache-2.0. Its current memory
experience includes:

- `/init` to inspect a project and bootstrap or refresh memory;
- `/remember` to teach an explicit durable rule;
- `/doctor` to audit duplication, hierarchy, and prompt cost;
- `/memory` and `/palace` to inspect memory;
- "dreaming" background subagents that review recent conversations and
  consolidate useful lessons after configured completed-step counts or
  compaction events;
- an optional second background review before updates are applied.

MemFS stores memory in a Git repository projected as ordinary Markdown files.
Files under `system/` remain in context; other files remain out of context while
their paths act as retrieval signposts. Every memory edit is committed, and
memory workers use Git worktrees to update memory concurrently. Semantic/vector
search is not built into MemFS by default; an optional mod adds keyword or
hybrid search.

**Term2 fit:** borrow the lifecycle and visibility, not the agent runtime.
Term2 already has project-scoped records, subagents, rollover boundaries, and a
local-first store. Replacing those with MemFS or the Letta server would couple
Term2's provider-neutral run loop to a competing stateful-agent platform.

Sources:

- [Letta Code repository](https://github.com/letta-ai/letta-code)
- [Memory and dreaming](https://docs.letta.com/letta-code/memory)
- [MemFS design](https://docs.letta.com/concepts/memfs)
- [Letta slash commands](https://docs.letta.com/letta-code/slash-commands)
- [Letta stateful-agent memory model](https://docs.letta.com/guides/agents/memory/)
- [Letta archival memory](https://docs.letta.com/guides/agents/archival-memory/)

### LangMem: background extraction and consolidation primitives

LangMem is an MIT-licensed Python library. It distinguishes hot-path memory
tools from a background manager that extracts, updates, and consolidates
memories after the response. Its documentation explicitly recommends delayed
processing/debouncing instead of processing every message. It separates:

- semantic memory: facts and knowledge;
- episodic memory: examples of successful past behavior;
- procedural memory: behavior and instruction changes;
- profiles: bounded, editable current state;
- collections: open-ended memories retrieved on demand.

The core operation supplies a model with new conversation material and current
memory state, then asks it to insert or consolidate structured memories.

**Term2 fit:** this is the best reference for a `MemoryReflectionScheduler` and
typed candidate extraction, but the package itself is Python/LangGraph-oriented.
Reimplementing the small workflow against Term2's existing model and memory
interfaces is lower-risk than introducing LangGraph as a second runtime.

Sources:

- [LangMem overview](https://langchain-ai.github.io/langmem/)
- [Background quickstart](https://langchain-ai.github.io/langmem/background_quickstart/)
- [Conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangMem repository](https://github.com/langchain-ai/langmem)

### Mem0: a complete extraction and retrieval engine

Mem0 is Apache-2.0 and offers both Python and npm clients, a self-hosted server,
and a managed platform. Its documented pipeline performs asynchronous
post-response extraction, related-memory lookup, LLM distillation,
deduplication, embedding, optional entity linking, and temporal annotation.
Retrieval fuses semantic, BM25, entity, and temporal signals.

Its default local library stack still assumes an LLM, OpenAI embeddings, local
Qdrant, and SQLite history; the server stack uses Postgres/pgvector by default.
The repository warns that published managed-platform benchmark results include
proprietary optimizations not available in the open-source SDK. The current
documented algorithm is ADD-only: changed facts coexist rather than being
destructively updated, preserving history but making knowledge-update ranking a
harder retrieval problem.

**Term2 fit:** valuable as a benchmark opponent and source of extraction,
deduplication, and multi-signal retrieval patterns. Making it the default would
duplicate Term2's existing store and add model, embedder, and vector-store
configuration. An adapter experiment is reasonable only after Term2 has a
memory-quality harness.

Sources:

- [Mem0 open-source overview](https://docs.mem0.ai/open-source/overview)
- [Mem0 memory architecture and evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation)
- [Mem0 repository](https://github.com/mem0ai/mem0)
- [Mem0 graph-memory source documentation](https://github.com/mem0ai/mem0/blob/v1.0.10/docs/open-source/features/graph-memory.mdx)

### Graphiti: temporal facts and contradiction history

Graphiti is an Apache-2.0 Python framework for building temporal context graphs.
It stores source episodes, entities, and fact edges. Edges carry both real-world
validity (`valid_at` / `invalid_at`) and system processing time
(`created_at` / `expired_at`). A contradictory update invalidates rather than
deletes the old edge, retaining provenance and point-in-time history. Retrieval
combines semantic, BM25, and graph traversal.

Its fact and contradiction extraction uses LLM calls, and the framework needs a
graph backend. It does not understand Git objects, file ranges, or compiler
symbols without application-specific metadata.

**Term2 fit:** adopt the bitemporal/supersession data model in a simpler record
schema. Do not require a graph database until observed queries need relationship
traversal that a flat store and metadata filters cannot answer.

Sources:

- [Graphiti repository](https://github.com/getzep/graphiti)
- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [Graphiti temporal model](https://getzep-graphiti.mintlify.app/concepts/temporal-model)
- [Graphiti edge model](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py)

## Local retrieval technology

### SQLite FTS5: recommended first index

SQLite FTS5 supplies full-text indexing, phrase/prefix/NEAR queries, snippets,
column weighting, and built-in BM25 ranking. It is deterministic, local, and
already compatible with Term2's shipped `better-sqlite3` dependency.

Recommended shape:

- keep `FileMemoryStore` as the canonical, inspectable source;
- maintain a rebuildable SQLite sidecar keyed by scope and memory ID;
- index title, summary, tags, content, kind, status, and source symbols;
- search global and project memories together but boost the project scope;
- make every result cite the canonical record ID;
- rebuild if the sidecar is missing or its source revision is stale.

This is a replacement for the current substring scorer, not a replacement for
the store.

Source: [SQLite FTS5 documentation](https://sqlite.org/fts5.html).

### `sqlite-vec`: viable optional semantic index, not an MVP dependency

`sqlite-vec` is an Apache-2.0, dependency-free C extension that stores float,
int8, or binary vectors in SQLite and exposes nearest-neighbor queries. Its npm
package loads into `better-sqlite3`, `node:sqlite`, and other JavaScript SQLite
bindings. The project explicitly labels itself pre-v1 and warns that breaking
changes should be expected.

**Term2 fit:** technically direct because Term2 already uses `better-sqlite3`.
Treat vector rows as derived data and pin a tested extension version. Do not
make vector search mandatory until packaging is verified across Term2's
supported platforms and an evaluation shows enough semantic-recall benefit.

Sources:

- [`sqlite-vec` repository](https://github.com/asg017/sqlite-vec)
- [`sqlite-vec` JavaScript integration](https://alexgarcia.xyz/sqlite-vec/js.html)

### Local embeddings

Two current Node-compatible paths are practical:

- `@huggingface/transformers` provides a JavaScript `feature-extraction`
  pipeline, downloads and caches ONNX models, and supports sentence-similarity
  models such as MiniLM-class encoders.
- `node-llama-cpp` exposes TypeScript embedding and reranking APIs for local
  GGUF models and documents cosine-similarity retrieval and external vector
  database integration.

ONNX Runtime publishes prebuilt Node CPU binaries for Windows and Linux on x64
and arm64 and macOS on x64 and arm64. GPU support is narrower. Any default local
embedder therefore needs a separate artifact-size, first-run download,
offline-install, latency, and architecture test matrix.

Sources:

- [Transformers.js pipeline documentation](https://huggingface.co/docs/transformers.js/en/pipelines)
- [ONNX Runtime Node bindings](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [`node-llama-cpp` embedding guide](https://node-llama-cpp.withcat.ai/guide/embedding)

### Hybrid retrieval

The consistent pattern across Mem0 and Graphiti is to retrieve lexical and
semantic candidates independently, then fuse ranks. Term2 should begin with
FTS5 and metadata boosts. If vectors are added, use rank fusion rather than
letting vector distance erase exact identifiers, file paths, commands, and
symbol names that lexical search handles well.

## Trust, provenance, and staleness technology

### Git for exact source provenance

Git commit, tree, and blob IDs provide immutable snapshot identity. A memory can
record repository identity, commit ID, file path, blob ID, and a source excerpt
or fingerprint. Comparing that anchor with `HEAD`, the index, and the worktree
can identify records that need revalidation. Rename detection can help follow
moves but is similarity-based, not semantic identity.

Source: [Git data model](https://git-scm.com/docs/gitdatamodel) and
[Git object model](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).

### TypeScript Language Service for semantic anchors

For TypeScript/JavaScript projects, the compiler API and Language Service expose
`Program`, `SourceFile`, `TypeChecker`, symbol lookup, definitions,
implementations, and references. A durable anchor can combine project config,
file path, declaration kind, qualified symbol context, source span, and a
declaration fingerprint. Symbol identity still depends on the project/compiler
context and must not be reduced to a line number.

Sources:

- [Using the TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [Using the TypeScript Language Service API](https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API)

### Tree-sitter for language-general syntax anchors

Tree-sitter supplies concrete syntax trees, named nodes, byte/point ranges,
error-tolerant parsing, incremental edits, and changed ranges. It can locate and
revalidate structural anchors across supported languages, but it is not a
cross-file semantic resolver. Persistent anchors need a subtree/text
fingerprint and re-anchoring procedure because positional ranges shift.

Sources:

- [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/)
- [Basic parsing and node model](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html)
- [Incremental parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)

### Recommended trust sequence

Do not start with a multi-language semantic graph. Add trust in increasing cost:

1. source session ID plus memory creator and timestamp;
2. Git commit/blob, file path, and exact excerpt/hash where applicable;
3. mark `needs_review` when an anchored blob or excerpt changes;
4. add TypeScript symbol anchors for TypeScript projects;
5. add Tree-sitter only when measured cross-language demand justifies grammar
   packaging and re-anchoring complexity.

A changed file should mark a memory as potentially stale, not automatically
false. Code can move without invalidating a decision, and unchanged code can be
superseded by a new user decision.

## Laya assessment

[Laya](https://huggingface.co/convaiinnovations/laya) is an Apache-2.0,
non-autoregressive typed-decision model. It accepts a state plus fixed-answer
`choice`, bounded `score`, and yes/no (`noul`) questions and returns values and
probabilities in one encoder forward pass. Its family contains 322M-421M
parameter checkpoints. The Python package can run locally, expose HTTP or MCP,
or use ONNX Runtime. The model card reports roughly 33-40 ms GPU latency for a
single short decision and 193-464 ms CPU latency when checkpoints are warm;
weights are approximately 647-808 MB depending on the checkpoint.

Potential Term2 questions for a future domain-tuned Laya classifier are:

- Did this completed turn contain durable project knowledge?
- Is the candidate an explicit user rule, verified repository fact, decision,
  procedure, or temporary state?
- Is confidence high enough to auto-save, or must the candidate be reviewed?
- Does this incoming task need project-memory retrieval?

Laya cannot produce the memory text because its output is restricted to fixed
options. It also provides no storage, retrieval, provenance, source validation,
or contradiction resolution. Another model or deterministic extractor remains
necessary.

The current model card reports important limitations:

- base checkpoints score below the majority baseline on its typed-decisions
  benchmark; the strong result belongs to a checkpoint fine-tuned on that
  benchmark's training split;
- high-cardinality choices degrade at default option-token budgets;
- yes/no answers have a documented label-following failure mode;
- probabilities require domain-specific temperature fitting before they should
  be trusted;
- the primary SDK is Python, so Term2 would need a local HTTP/MCP sidecar or a
  separately validated ONNX integration.

**Recommendation:** do not make Laya an MVP dependency. First log a privacy-safe
Term2 dataset of proposed trigger/classification decisions and their user review
outcomes. Then compare a fine-tuned Laya checkpoint against the existing cheap
model tier on precision, recall, abstention, latency, resident memory, and
packaging. Laya is attractive only if it can remove enough autoregressive model
calls to justify a large resident checkpoint and Python/ONNX integration.

Sources:

- [Laya model card](https://huggingface.co/convaiinnovations/laya)
- [Laya repository](https://github.com/NandhaKishorM/laya)
- [Laya structured decisions](https://nandhakishorm.github.io/laya/structured/)

## Proposed Term2 architecture

### 1. Canonical records plus derived indexes

Keep memory records canonical in the existing local store. Extend metadata with
optional fields rather than encoding lifecycle state in tags:

```text
kind: preference | convention | architecture | decision | procedure | episode
status: candidate | active | needs_review | superseded
confidence: explicit | verified | inferred
source: session IDs, user/assistant record IDs, commit/blob/path/symbol anchors
validFrom / validUntil
supersedes / supersededBy
lastVerifiedAt
```

Build FTS5/vector indexes as disposable projections. Preserve old facts when a
new fact supersedes them; default retrieval should select current active facts,
while audit and historical queries can request superseded records.

### 2. Automatic recall at request admission

Before the first provider request for a new user task:

1. query active project memories using the user request and cheap deterministic
   context such as path, branch, and mentioned symbols;
2. inject only a small ranked set of summaries with stable IDs;
3. let the agent fetch full content when needed;
4. emit a quiet TUI receipt only when retrieved memory materially enters the
   request.

Retrieval must be bounded and observable. Record candidates, selected IDs,
scores, and token cost in local diagnostics so relevance can be evaluated.

### 3. Idle-boundary reflection

Schedule reflection only after meaningful boundaries: a completed task with
tool activity, an accepted decision, an explicit correction, a rollover, or a
configured amount of settled work. Debounce repeated turns and process only the
new transcript delta plus nearby existing memories.

Use the existing librarian/background-run machinery to return structured
operations (`create`, `update`, `supersede`, `ignore`) with evidence. The owner
of the memory store validates and applies those operations; a subagent must not
become an unreviewed second writer.

### 4. Confidence and user control

- Explicit user rules may become active immediately with an undo receipt.
- Repository-derived facts should be candidates until their cited source is
  checked.
- Inferred architecture or preference claims should require review.
- Temporary task state should be ignored or remain in the session checkpoint,
  not durable memory.

Expose at least `/memory recent`, `/memory used`, `/memory review`,
`/memory remember <text>`, and `/memory undo`. The first product signal is the
receipt, not a large dashboard.

### 5. Maintenance

Run cheap deterministic maintenance on source changes and expensive model-based
consolidation only at idle boundaries. A memory doctor can merge duplicates,
flag contradictory active facts, measure prompt/index cost, and propose
reorganization. Destructive cleanup should retain an audit trail or be
reversible.

## Delivery sequence

### Phase A — visible active loop, no new retrieval dependency

- Structured candidate schema and provenance fields.
- Reflection trigger with debounce and bounded input.
- Candidate review/undo flow.
- "used" and "learned" receipts.
- Evaluation fixtures for explicit rule, durable code fact, correction,
  duplication, temporary state, and unsupported inference.

### Phase B — FTS5 automatic recall

- Rebuildable FTS5 memory sidecar using existing `better-sqlite3`.
- Project/global scope weighting and metadata filters.
- Admission-time retrieval with bounded injection.
- Retrieval traces and a code-project adaptation of LongMemEval dimensions.

### Phase C — provenance and staleness

- Git/blob/path anchors and source excerpts.
- `needs_review` on changed anchors.
- TypeScript symbol anchors for TS/JS projects.
- Historical/superseded retrieval.

### Phase D — semantic retrieval experiment

- Compare FTS5 against FTS5 + local embeddings + rank fusion.
- Test `sqlite-vec` packaging on every supported Term2 platform.
- Measure recall, precision, latency, resident memory, index size, first-run
  download, and tokens injected.
- Ship only if the semantic arm wins on real project-memory queries.

### Phase E — optional Laya gate experiment

- Build a reviewed decision dataset from earlier phases.
- Fine-tune and calibrate Laya on the exact Term2 schemas.
- Compare against deterministic rules and the existing cheap-model tier.
- Keep it optional unless accuracy and resource economics clearly win.

## Evaluation requirements

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) supplies five useful
dimensions: information extraction, multi-session reasoning, knowledge updates,
temporal reasoning, and abstention. Its data is conversational rather than
code-aware, so Term2 also needs tests for:

- exact provenance back to a session and source snapshot;
- current versus superseded decisions;
- stale-anchor detection after edits, moves, and refactors;
- retrieval of exact commands, paths, and symbols;
- resistance to unsupported inferences and malicious memory content;
- user correction, undo, and deletion;
- precision of automatic writes, not only recall of stored facts;
- latency, model cost, and injected-token budget.

Sources:

- [LongMemEval paper](https://arxiv.org/abs/2410.10813)
- [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval)

## Decision

Build an application-owned active memory lifecycle on top of Term2's current
store. Borrow Letta's visible UX, LangMem's delayed reflection pattern, Mem0's
multi-signal retrieval discipline, and Graphiti's non-destructive temporal
model. Use existing SQLite/FTS5 first. Treat vectors, graph storage, and Laya as
measured follow-on experiments rather than prerequisites.
