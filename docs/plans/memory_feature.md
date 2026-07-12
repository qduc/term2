# Term2 Memory — MVP Specification

## 1. Purpose

Add persistent memory to Term2 so agents can retain durable information across sessions without injecting the entire memory store into every model context.

The MVP should provide:

* transparent local persistence;
* deterministic retrieval;
* lazy loading;
* explicit agent-facing memory tools;
* minimal automatic behavior;
* a stable foundation for a future Memory Librarian agent.

The memory store is a runtime primitive. The future librarian must use the same public memory API as ordinary agents.

---

## 2. Design Principles

### Keep memory explicit

The MVP should not automatically save arbitrary conversation content.

The agent may propose or perform memory operations through tools, but storage behavior must remain visible, inspectable, and predictable.

### Load summaries first

Only a compact memory index should enter the initial agent context.

Full memory content should be loaded only when the agent determines that it is relevant.

### Prefer files over infrastructure

Use local files.

Do not introduce:

* vector databases;
* embeddings;
* external services;
* multiple storage backends;
* background workers;
* semantic indexing;
* database migrations.

### Separate memory from workflow state

Memory contains durable knowledge that may matter in future sessions.

Temporary plans, intermediate results, tool outputs, and current-task scratchpads belong to workflow state, not memory.

---

## 3. Goals

The MVP must allow an agent to:

1. inspect available memories;
2. retrieve a full memory item;
3. search memories using deterministic text matching;
4. create a memory;
5. update a memory;
6. delete a memory.

Memory must persist across Term2 sessions.

The implementation should be understandable by reading the files directly.

---

## 4. Non-Goals

The MVP will not include:

* automatic extraction from every conversation;
* automatic consolidation or deduplication;
* embeddings or semantic search;
* relevance ranking using an LLM;
* multiple users or shared remote memory;
* multiple storage adapters;
* automatic expiration;
* background organization;
* memory graphs;
* relationships between memory items;
* access-control policies;
* version history;
* a dedicated librarian agent.

These may be added later if actual usage demonstrates a need.

---

## 5. Storage Layout

Store memory inside the Term2 data directory.

Recommended layout:

```text
.term2/
  memory/
    index.json
    items/
      <memory-id>.md
```

Example:

```text
.term2/
  memory/
    index.json
    items/
      user-working-style.md
      term2-architecture.md
```

The exact root directory may follow Term2’s existing configuration conventions.

The memory module should receive the resolved root path rather than independently deciding where data lives.

---

## 6. Memory Model

```ts
export type MemoryId = string;

export interface MemoryMetadata {
  id: MemoryId;
  title: string;
  summary: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Memory extends MemoryMetadata {
  content: string;
}
```

### Field semantics

#### `id`

A stable, human-readable identifier.

Examples:

```text
user-working-style
term2-agent-runtime
jira-writing-preferences
```

IDs must:

* contain lowercase ASCII letters, numbers, and hyphens;
* begin and end with a letter or number;
* be unique within the store.

Recommended validation:

```regex
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

The ID should not change when the title changes.

#### `title`

A concise human-readable name.

Example:

```text
User working style
```

#### `summary`

A compact description used in the initial context index and search results.

The summary should explain when the memory is relevant, not merely repeat its title.

Good:

```text
How the user prefers technical ideas to be evaluated, including a preference for critical analysis over automatic agreement.
```

Weak:

```text
Information about user working style.
```

Recommended maximum length:

```text
300 characters
```

#### `content`

The complete memory.

Use Markdown.

The content may contain explanations, decisions, examples, constraints, and relevant context.

#### `tags`

Optional deterministic retrieval hints.

Examples:

```json
["term2", "architecture", "agents"]
```

Tags should remain lightweight. Do not build a taxonomy system in the MVP.

#### Timestamps

Use ISO 8601 UTC strings.

Example:

```text
2026-07-12T04:30:00.000Z
```

---

## 7. File Format

### `index.json`

The index contains metadata only.

```json
{
  "version": 1,
  "memories": [
    {
      "id": "term2-agent-runtime",
      "title": "Term2 agent runtime",
      "summary": "Architectural decisions for Term2's dynamic workflow and subagent runtime.",
      "tags": ["term2", "architecture", "agents"],
      "createdAt": "2026-07-12T04:30:00.000Z",
      "updatedAt": "2026-07-12T04:30:00.000Z"
    }
  ]
}
```

The full content must not be duplicated in the index.

### Memory item files

Each item is stored as Markdown:

```text
items/<id>.md
```

The file contains only the memory content.

Example:

```md
Term2 should expose general-purpose primitives for creating and coordinating
temporary agents.

Specialized capabilities such as reviewers, mentors, and memory librarians
should be ordinary agents built on the runtime rather than hard-coded features.
```

Metadata remains in `index.json`.

This avoids parsing frontmatter and establishes one source of truth for metadata.

---

## 8. Core Service API

Create a storage-independent service interface, but implement only one filesystem-backed service.

Do not build a pluggable backend framework.

```ts
export interface MemoryStore {
  list(options?: ListMemoriesOptions): Promise<MemoryMetadata[]>;

  get(id: MemoryId): Promise<Memory | null>;

  search(
    query: string,
    options?: SearchMemoriesOptions,
  ): Promise<MemorySearchResult[]>;

  create(input: CreateMemoryInput): Promise<Memory>;

  update(
    id: MemoryId,
    input: UpdateMemoryInput,
  ): Promise<Memory>;

  remove(id: MemoryId): Promise<boolean>;
}
```

Supporting types:

```ts
export interface ListMemoriesOptions {
  limit?: number;
}

export interface SearchMemoriesOptions {
  limit?: number;
}

export interface MemorySearchResult {
  memory: MemoryMetadata;
  matchedFields: Array<"id" | "title" | "summary" | "tags" | "content">;
}

export interface CreateMemoryInput {
  id: MemoryId;
  title: string;
  summary: string;
  content: string;
  tags?: string[];
}

export interface UpdateMemoryInput {
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
}
```

Naming may be adapted to existing Term2 conventions.

The behavioral contract is more important than the exact TypeScript names.

---

## 9. Storage Behavior

### Initialization

When the memory directory does not exist:

1. create the memory directory;
2. create the `items` directory;
3. create an empty version-one index.

Empty index:

```json
{
  "version": 1,
  "memories": []
}
```

### Create

Creating a memory must:

1. validate the input;
2. reject an existing ID;
3. write the Markdown content;
4. add metadata to the index;
5. persist the updated index;
6. return the complete memory.

### Update

Updating a memory must:

1. confirm that the ID exists;
2. preserve fields not included in the update;
3. update `updatedAt`;
4. write content only when content changed;
5. update index metadata;
6. return the complete updated memory.

The memory ID is immutable in the MVP.

Renaming an ID should be treated as creating a new memory and deleting the old one.

### Delete

Deleting a memory must:

1. remove its metadata from the index;
2. remove its item file;
3. return whether the memory existed.

A missing item file should not prevent the index entry from being removed.

### Atomicity

Avoid leaving the index partially written.

Write JSON to a temporary file and rename it into place:

```text
index.json.tmp
index.json
```

Use the operating system’s atomic rename behavior where available.

For MVP simplicity, operations may be serialized within the process using a mutex or promise queue.

Cross-process locking is not required unless Term2 already supports concurrent processes writing to the same data directory.

---

## 10. Validation

Reject memories with:

* invalid IDs;
* empty titles;
* empty summaries;
* empty content;
* summaries over the configured limit;
* malformed tags;
* duplicate IDs.

Normalize tags by:

* trimming whitespace;
* converting to lowercase;
* removing duplicates;
* removing empty values.

Use typed domain errors where useful:

```ts
MemoryNotFoundError
MemoryAlreadyExistsError
InvalidMemoryError
MemoryStorageError
```

Do not expose raw filesystem errors directly to the model.

---

## 11. Search

Search must remain deterministic and local.

Search these fields:

1. exact ID;
2. title;
3. summary;
4. tags;
5. content.

Matching should be case-insensitive.

Split the query into whitespace-delimited terms and rank results using a small fixed scoring function.

Example:

```text
exact ID match:       +100
ID contains term:      +20
title contains term:   +15
tag equals term:       +12
summary contains term: +8
content contains term: +2
```

Add scores for each matching query term.

Sort by:

1. score descending;
2. `updatedAt` descending;
3. ID ascending.

The exact weights may differ, but they must be fixed and covered by tests.

Return metadata and matched fields by default.

Do not return the full content for every result. The agent can call `memory_get` for selected memories.

A reasonable default search limit is:

```text
10
```

A reasonable hard maximum is:

```text
50
```

---

## 12. Agent Tools

Expose the memory service through small agent-facing tools.

Recommended tools:

```text
memory_list
memory_get
memory_search
memory_create
memory_update
memory_delete
```

Follow Term2’s existing naming conventions if they differ.

### `memory_list`

Purpose:

Inspect the available memory index.

Input:

```ts
{
  limit?: number;
}
```

Output:

```ts
{
  memories: MemoryMetadata[];
}
```

### `memory_get`

Purpose:

Load one full memory after identifying it as relevant.

Input:

```ts
{
  id: string;
}
```

Output:

```ts
{
  memory: Memory;
}
```

Return a structured not-found error when absent.

### `memory_search`

Purpose:

Find likely memories using deterministic text search.

Input:

```ts
{
  query: string;
  limit?: number;
}
```

Output:

```ts
{
  results: MemorySearchResult[];
}
```

### `memory_create`

Purpose:

Persist new durable knowledge.

Input:

```ts
CreateMemoryInput
```

Output:

```ts
{
  memory: Memory;
}
```

### `memory_update`

Purpose:

Correct, refine, or extend an existing memory.

Input:

```ts
{
  id: string;
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
}
```

Output:

```ts
{
  memory: Memory;
}
```

### `memory_delete`

Purpose:

Remove incorrect or no-longer-useful memory.

Input:

```ts
{
  id: string;
}
```

Output:

```ts
{
  deleted: boolean;
}
```

Tool descriptions should explain behavior and constraints, but should not contain a large memory-management policy. Behavioral guidance belongs in the agent prompt.

---

## 13. Context Injection

At the beginning of an agent session, inject a compact memory index.

Example:

```md
## Persistent memory

The following memories are available from previous sessions. These are summaries,
not their complete contents. Load a memory with the memory tools when it may be
relevant.

- `term2-agent-runtime` — Architectural decisions for Term2's dynamic workflow and subagent runtime.
- `user-working-style` — How the user prefers technical ideas to be evaluated and discussed.
```

Do not inject:

* full memory content;
* timestamps;
* tags unless they materially improve retrieval;
* internal filesystem paths;
* JSON;
* memories beyond the configured context budget.

### Empty state

When there are no memories, omit the section entirely.

### Budget

The memory index must have a configurable character or token budget.

Recommended initial behavior:

1. sort memories by `updatedAt` descending;
2. add entries until the budget is exhausted;
3. include a final note when some memories are omitted.

Example:

```md
Additional memories are available through `memory_list` and `memory_search`.
```

Recommended initial budget:

```text
2,000–4,000 characters
```

Start with a character budget unless Term2 already has reliable token counting.

### Index freshness

Generate the injected index from the persisted metadata at session creation.

The context does not need to update when memories change during the same turn. Tools return the current state.

A later agent turn or session may regenerate the index.

---

## 14. Agent Guidance

Add concise guidance when memory tools are available.

Suggested behavior:

```md
### Persistent memory

You have access to persistent memory from previous sessions.

Use memory when information from earlier work may affect the current task. The
initial memory list contains summaries only; load full memories selectively.

Store information only when it is likely to remain useful across future
sessions, such as:

- stable user preferences;
- durable project decisions;
- important architectural constraints;
- recurring workflows;
- corrections that should prevent future mistakes.

Do not store:

- temporary task state;
- intermediate reasoning;
- ordinary conversation details;
- information already represented accurately by an existing memory;
- secrets or sensitive data unless the user explicitly requests persistence.

Prefer updating an existing memory over creating a near-duplicate.
```

Do not force the agent to execute a rigid memory workflow on every task.

Modern models should be allowed to exercise judgment within these boundaries.

---

## 15. User Control

Memory operations should remain controllable by the user.

The agent must comply with explicit requests such as:

```text
Remember this.
Update the memory about Term2 architecture.
Forget that preference.
What do you remember about this project?
```

When the user explicitly asks to save something, the agent should normally call the relevant memory tool rather than merely acknowledge the request.

When the user explicitly asks to forget something, the agent should delete or update the relevant memory.

For ambiguous destructive requests, the agent may search before deleting.

The MVP does not require an interactive confirmation layer inside the memory service.

---

## 16. CLI and Human Inspection

The files themselves are the primary inspection mechanism.

Optional CLI commands are useful but not required for the first implementation.

Potential commands:

```text
term2 memory list
term2 memory show <id>
term2 memory search <query>
term2 memory delete <id>
```

Do not delay the core service and tools to build a full memory-management interface.

---

## 17. Corruption and Recovery

On startup, validate that:

* `index.json` parses successfully;
* the index version is supported;
* memory IDs are unique;
* metadata has required fields.

When the index is invalid, return a clear error identifying the file.

Do not silently replace a corrupted index with an empty store.

When metadata exists but the item file is missing:

* `list` may still return its metadata;
* `get` must return a storage-integrity error;
* `delete` must still be able to remove the broken entry.

When an unindexed Markdown file exists, ignore it in the MVP.

Automatic repair and index reconstruction are non-goals.

---

## 18. Configuration

Recommended configuration:

```ts
export interface MemoryConfig {
  enabled: boolean;
  directory: string;
  contextBudgetChars: number;
  searchDefaultLimit: number;
  searchMaxLimit: number;
}
```

Suggested defaults:

```ts
{
  enabled: true,
  directory: "<term2-data-dir>/memory",
  contextBudgetChars: 3000,
  searchDefaultLimit: 10,
  searchMaxLimit: 50
}
```

Avoid adding configuration that has no immediate implementation use.

---

## 19. Security and Privacy

Memory files may contain user or project information.

The implementation must:

* keep memory inside the configured local data directory;
* prevent path traversal through memory IDs;
* never interpret IDs as arbitrary paths;
* avoid logging complete memory content by default;
* avoid returning raw filesystem paths to the model;
* respect explicit user deletion requests.

The MVP does not need encryption at rest.

Document that memory is stored as plaintext locally.

---

## 20. Integration with the Workflow Runtime

The memory store is a shared runtime capability.

Any agent granted the memory tools may use it.

The workflow runtime should allow memory tools to be included in an agent’s tool set:

```ts
const agent = createAgent({
  tools: [
    ...defaultTools,
    ...memoryTools,
  ],
});
```

Tool access should be explicit.

A temporary worker that does not need persistent memory should not automatically receive write access.

The runtime may eventually distinguish capabilities such as:

```text
memory:read
memory:write
memory:delete
```

Capability-level permissions are optional for the MVP. A simple decision to include or omit memory tools is sufficient initially.

---

## 21. Future Memory Librarian

The librarian is deferred until the storage and retrieval primitives have been proven through real use.

The librarian will be an ordinary specialized agent created through the workflow runtime.

Conceptually:

```ts
const librarian = agent({
  role: "memory librarian",
  tools: memoryTools,
});
```

Potential librarian responsibilities:

* decide whether new information is worth storing;
* find an existing memory to update;
* merge duplicate memories;
* improve titles and summaries;
* organize overly broad memories;
* retrieve memories for another agent;
* identify stale or contradictory information.

The librarian must not access storage internals directly.

It must use the same public memory tools as other agents.

This ensures the memory API remains sufficient and prevents the librarian from becoming a privileged hard-coded subsystem.

---

## 22. Suggested Implementation Order

### Step 1: Domain types and validation

Implement:

* memory types;
* ID validation;
* input normalization;
* typed errors.

### Step 2: Filesystem store

Implement:

* initialization;
* index loading;
* atomic index writing;
* item reading and writing;
* serialized mutations.

### Step 3: Read operations

Implement and test:

* `list`;
* `get`;
* `search`.

### Step 4: Write operations

Implement and test:

* `create`;
* `update`;
* `remove`.

### Step 5: Agent tools

Expose each service operation through Term2’s tool system.

### Step 6: Context injection

Generate the summary-only memory section under a fixed budget.

### Step 7: Agent guidance

Add concise behavioral instructions when memory tools are enabled.

### Step 8: End-to-end validation

Run a multi-session scenario:

1. start with an empty store;
2. save a durable project decision;
3. end the session;
4. start a new session;
5. observe the summary in initial context;
6. retrieve the full memory;
7. update it;
8. search for it;
9. delete it.

Do not implement the librarian as part of this sequence.

---

## 23. Testing Requirements

### Unit tests

Cover:

* valid and invalid IDs;
* input normalization;
* duplicate IDs;
* missing memories;
* partial updates;
* timestamp changes;
* tag normalization;
* deterministic search scoring;
* search tie-breaking;
* context budget truncation.

### Filesystem tests

Use a temporary directory.

Cover:

* first-run initialization;
* persistence across store instances;
* item creation;
* item update;
* deletion;
* malformed index;
* missing content file;
* atomic index replacement;
* concurrent in-process mutations.

### Tool tests

Cover:

* schema validation;
* successful structured responses;
* conversion of domain errors into safe tool errors;
* absence of raw paths and stack traces.

### Integration tests

Verify that:

* metadata appears in initial context;
* full content does not appear automatically;
* an agent can load a relevant memory;
* memory survives a new Term2 process;
* disabling memory removes both tools and injected context.

---

## 24. Acceptance Criteria

The MVP is complete when:

1. memories persist locally across Term2 sessions;
2. the initial agent context contains summaries only;
3. full memory is loaded only through an explicit tool call;
4. agents can list, search, create, read, update, and delete memories;
5. search is deterministic and requires no model or embedding service;
6. memory storage can be inspected and edited using ordinary files;
7. corruption produces visible errors instead of silent data loss;
8. temporary workflow state is not automatically persisted;
9. the implementation contains no librarian-specific storage path;
10. the feature can be disabled cleanly;
11. tests cover the complete persistence lifecycle.

---

## 25. MVP Boundary

The implementation should stop once the acceptance criteria are satisfied.

Do not add the librarian merely because the workflow runtime now makes it easy.

First use the primitive memory system during real Term2 work. Observe:

* what the agent chooses to store;
* whether it creates duplicates;
* whether summaries are useful;
* how often search is needed;
* whether context injection becomes noisy;
* which operations require better judgment.

Those observations should define the librarian workflow rather than assumptions made before the memory system is used.
