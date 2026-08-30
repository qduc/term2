# Token-safe persistent-memory retrieval and local session browser

> **Status: implemented and merged in `6d36e624`.**
>
> ## Resume here
>
> This document is the normative contract and implementation record for bounded
> persistent-memory retrieval and a read-only browser for local prior-session
> transcripts. The implementation is owned by `fitSerializedEnvelope`,
> `matchCenteredSnippet`, `FileMemoryStore`, `createMemoryToolDefinitions`,
> `MemoryCapabilityBuilder`, `browseConversationsForProject`,
> `loadConversationForProjectReadOnly`, `SessionBrowser`, and
> `createSessionBrowserToolDefinitions`. A merge commit is recorded only after
> one exists.

## 1. Goal and non-goal

The current memory read tools serialize whole JavaScript objects with no
tool-result size limit. In particular, `memory_retrieve` can load every
matching memory from both scopes, and a memory's Markdown body has no stored
size limit. This can consume an unbounded portion of the next model request.

This slice makes the serialized tool result bounded and makes progressive
disclosure explicit:

1. `memory_search` returns compact metadata plus a deterministic, bounded
   content excerpt when content matched.
2. `memory_retrieve` returns complete ranked memories that fit as a group;
   omission diagnostics remain bounded.
3. `memory_get` preserves `{ scope, memory }` when a memory fits in one
   response and otherwise returns an explicit, cursor-paged content chunk.
   `memory_list` changes only as required by the universal response bound.
4. `session_list`, `session_search`, and cursor-based `session_read` provide
   on-demand access to the current project's locally persisted conversations.

This is an output-boundary feature, not a new persistence format. It does not
alter the `FileMemoryStore` on-disk layout, the conversation JSONL/sidecar
format, resume behavior, or the model's normal conversation history.

## 2. Terms and invariant

### 2.1 Character and envelope accounting

`character` means a JavaScript UTF-16 code unit. The normative measurement is:

```ts
const serialized = JSON.stringify(value);
const charsUsed = serialized.length;
```

It is deliberately not UTF-8 byte length, Unicode code-point count, terminal
display-cell width, or a tokenizer estimate. JSON escaping counts because it
is part of `serialized`: a newline in a value consumes two serialized
characters (`\\n`), and a quote consumes two (`\\"`).

Every success result in this specification satisfies all conditions:

```ts
const serialized = JSON.stringify(result);
serialized.length <= params.maxChars;
Buffer.byteLength(serialized, 'utf8') <= resolveToolResultMaxBytes();
result.charsUsed === JSON.stringify(result).length;
```

`charsUsed` is the complete JSON envelope, including property names, commas,
brackets, IDs, metadata, omission diagnostics, and `charsUsed` itself. It is
not a payload-only count. The implementation must set it by fixed-point
serialization: serialize with a provisional numeric value, replace it with
the resulting length, and repeat until the number is unchanged. The permitted
budgets make this converge in at most two digit-width changes; implementations
must assert convergence rather than publish an inaccurate count.

There is no hand-maintained “fixed envelope overhead” constant. For an output
shape, its fixed overhead is the actual serialized empty candidate of that
shape, including the final `charsUsed` field. Candidate admission is performed
by serializing the *whole proposed result*. Consequently an added comma,
escaped ID, changed count, or the digits in `charsUsed` cannot make a result
silently exceed its budget.

The memory/session result builder owns both checks and admits a candidate only
when the complete serialized JSON satisfies both. `charsUsed` remains the
UTF-16 measurement; byte use is not a new response field. The resolved cap is
the cap used later by `boundToolResultText`, so these tools must return that
same JSON unchanged: they must not rely on its UTF-8 truncation/spooling path,
which could make JSON invalid. `MAX_TOOL_OUTPUT_CHARS` is 12,000, which is at
most 36,000 UTF-8 bytes for serialized JSON and therefore fits the normal
40,000-byte resolved cap; direct byte admission still protects a lower runtime
override. Helpers must not use approximate field budgets or truncate serialized
JSON.

The root and subagent tool wrappers honor the tool-definition
`preserveSerializedOutput` marker for these self-bounded read results. They do
not apply generic per-string trimming or inject run-budget warning text into
the already measured JSON; doing either would invalidate `charsUsed` and could
break the envelope. Pending warning evidence remains available for a later
ordinary tool result.

### 2.2 Common input limits

All new `maxChars` inputs are strict Zod integers with these limits:

| Constant | Value | Meaning |
| --- | ---: | --- |
| `MIN_TOOL_OUTPUT_CHARS` | 512 | Smallest accepted requested budget. It fits every fixed success/error envelope in this specification. |
| `DEFAULT_INDEX_OUTPUT_CHARS` | 12,000 | Default for list and search results. |
| `DEFAULT_DOCUMENT_OUTPUT_CHARS` | 12,000 | Default for memory and transcript reads. |
| `MAX_TOOL_OUTPUT_CHARS` | 12,000 | Hard ceiling, regardless of settings or caller request. |
| `DEFAULT_RESULT_LIMIT` | 10 | Default number of ranked entries/candidates. |
| `MAX_RESULT_LIMIT` | 50 | Hard maximum number of ranked entries/candidates. |
| `CONTENT_SNIPPET_CHARS` | 240 | Maximum UTF-16 length of a memory or session search snippet. |
| `SESSION_READ_LIMIT` | 20 | Default transcript records in a page. |
| `SESSION_READ_MAX_LIMIT` | 50 | Maximum transcript records requested in a page. |

Existing memory settings retain their current meanings: the defaults for
`memory.searchDefaultLimit` and `memory.searchMaxLimit` are 10 and 50, and
`MemoryCapabilityBuilder` passes them to `FileMemoryStore`. For these tools,
the effective requested memory limit is the smaller of the configured maximum
and `MAX_RESULT_LIMIT`; an absent limit uses the configured default clamped to
that range. Session-browser limits are constants in this slice, not settings.

`maxChars` is optional on every read-only tool in this document. Index/search
tools default to `DEFAULT_INDEX_OUTPUT_CHARS`; complete-document tools default
to `DEFAULT_DOCUMENT_OUTPUT_CHARS`. A request above the hard maximum is a
schema error, never a request to enlarge the envelope.

### 2.3 Legacy identifiers and diagnostics

The live memory-ID grammar remains the creation and read grammar; this slice
adds no creation-time length cap. A historical valid opaque ID is accepted by
`memory_get`, including one not generated by current code. Diagnostic entries
use the compatible `{ scope, id }` shape only when that complete entry fits.
There is no digest, prefix, hashed reference, or substitute identifier. Input
candidate limits are capped at 50 and diagnostics are reserved before memories.
If an ID (or an additional diagnostic entry) cannot fit, omit that entry and
report the exact bounded generic count in `omittedIdCount` or
`unavailableIdCount`; never leak a partial ID or make a record inaccessible.

`generateId()` currently uses `crypto.randomUUID()`, but that fact is not
historical-read validation. Session IDs are safe opaque path components,
validated before path derivation, rather than UUID-only input.

### 2.4 Common bounded error envelope

The existing `safe()` behavior remains the conversion boundary for memory
domain failures. New tool-specific failures use this sanitized shape:

```ts
{
  error: {
    code:
      | 'not_found'
      | 'storage_error'
      | 'invalid_memory'
      | 'output_budget_exceeded'
      | 'invalid_cursor'
      | 'stale_cursor'
      | 'session_unavailable';
    message: string;
  };
}
```

Messages are fixed public strings; they contain no filesystem path, raw
exception, session text, or memory content. The error envelope is serialized
and asserted to fit the requested budget. Invalid Zod arguments continue to be
rejected by the normal tool invocation wrapper before execution.

`output_budget_exceeded` means that even the required bounded envelope cannot
fit. It is not permission to truncate serialized JSON. Its message is:
`"The requested result cannot fit in the output budget."`

The requested `maxChars` floor is large enough for every normal error envelope.
A runtime UTF-8 override can nevertheless be smaller than that envelope. In
that exceptional outer-cap case, `boundedJsonFailure` returns the smallest
valid JSON representation that fits: first
`{"error":{"code":"output_budget_exceeded"}}`, then the JSON literal `0`
when even that object cannot fit. The literal carries no diagnostic detail but
preserves the stronger invariant that the tool never emits invalid or
over-cap JSON.

## 3. Memory authority and unchanged behavior

`MemoryCapabilityBuilder` remains the sole authority that combines
`memory.enabled`, scope stores, role access, prompt guidance, and initial
summary context. The new bounds do not change its access policy: main and
librarian agents receive the write-capable memory set; explorer and worker
agents receive the read-only subset; other roles receive none.

Memory scopes retain their meanings and are not deduplicated:

- `global` is cross-project durable knowledge.
- `project` is the hashed current-project store selected by
  `MemoryCapabilityBuilder.#createStores()`.
- A global and a project record with the same `id` are two distinct records.
  Search and retrieve preserve `scope` on every result. `memory_get` remains
  deliberately compatible: it checks global first and returns that match;
  callers needing the project twin use list/search/retrieve evidence rather
  than assuming IDs are globally unique.

The main agent's initial summary context remains separately bounded by
`memory.contextBudgetChars` through `FileMemoryStore.contextSync()`. This plan
does not replace that prompt construction path with tool output.

## 4. Memory read-tool contracts

All examples show parsed JSON values. Tool executors still return their JSON
string through the existing `safe()` convention.

### 4.1 `memory_list`

**Input**

```ts
{
  limit?: integer; // effective configured default; 1..50 after clamp
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape (additive-compatible)**

```ts
{
  scope: 'all';
  global: MemoryMetadata[];
  project: MemoryMetadata[];
  omitted: { global: number; project: number };
  charsUsed: number;
}
```

`scope`, `global`, and `project` retain their current names and semantics.
`MemoryMetadata` retains every current field. The selected metadata is ordered
within each scope by `updatedAt` descending then `id` ascending, matching
`FileMemoryStore.list()`. The builder attempts global candidates first, then
project candidates, each in that order. It admits an entire metadata object or
omits it; metadata fields are never individually shortened. `omitted` counts
candidates skipped solely because adding their whole object would exceed the
envelope budget. A metadata item larger than an otherwise empty success result
is simply omitted and increments the appropriate count.

This is an intentionally additive response change. Callers that only read
`scope`, `global`, and `project` remain compatible. No available record is
silently represented by a fake or partial metadata object.

### 4.2 `memory_get`

**Input**

```ts
{
  id: string; // existing stable-ID grammar; legacy valid IDs remain accepted
  cursor?: string; // opaque cursor issued for this memory content
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape (additive-compatible)**

```ts
{
  scope: 'global' | 'project';
  memory: Memory;
  charsUsed: number;
}
```

Lookup order remains global then project. The returned `memory` is byte-for-byte
the complete stored string and complete metadata as returned by `MemoryStore`;
it is never content-truncated to satisfy `maxChars`. This is the sole success
shape when the complete memory fits, preserving existing `{ scope, memory }`
callers.

When the complete envelope does not fit, return this explicit page shape:

```ts
{
  scope: 'global' | 'project';
  memory: MemoryMetadata; // complete non-content fields from the same Memory
  content: { offset: number; totalChars: number; text: string; nextCursor?: string };
  charsUsed: number;
}
```

`text` is a surrogate-safe contiguous UTF-16 slice of `memory.content` starting
at `offset`; `totalChars` is `memory.content.length`. It is nonempty unless the
stored content is empty. `nextCursor` is present exactly when `offset +
text.length < totalChars` and advances to that offset. Thus every nonterminal
page advances and concatenating pages yields the complete original content.
The cursor pins `{ v: 1, scope, id, updatedAt, nextOffset }`; it is strict
canonical base64url JSON, has no extra fields or content, must match the
requested ID/scope selected by global-first lookup, and returns `invalid_cursor`
or `stale_cursor` on invalidity or changed memory identity/version. A missing
memory remains `not_found`. Not-found and storage failures retain their
sanitized codes.

### 4.3 `memory_search`

**Input**

```ts
{
  query: string; // must contain at least one non-whitespace term
  limit?: integer; // effective configured default; 1..50 after clamp
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape**

```ts
{
  results: Array<{
    scope: 'global' | 'project';
    memory: MemoryMetadata;
    matchedFields: Array<'id' | 'title' | 'summary' | 'tags' | 'content'>;
    available: boolean;
    contentSnippet?: { text: string; truncated: boolean };
  }>;
  omitted: number;
  charsUsed: number;
}
```

`memory`, `matchedFields`, and `available` are preserved from the live search
result; `scope`, `contentSnippet`, `omitted`, and `charsUsed` are additive.
`omitted` is the count of ranked result records not emitted because the full
record (including metadata and a snippet where applicable) did not fit. It is
not a count of unmatched memories.

#### Matching, ranking, and cross-scope ordering

Search retains `FileMemoryStore.search()` semantics. Split the trimmed query
on whitespace, lowercase terms with JavaScript `toLowerCase()`, and reject no
terms. For every term, add these fixed scores once per matching field:

| Match | Score |
| --- | ---: |
| ID exactly equals term | 100 |
| ID contains term (when not exact) | 20 |
| title contains term | 15 |
| tag equals or contains term | 12 |
| summary contains term | 8 |
| full content contains term | 2 |

All fields match case-insensitively using the same lowercasing rule. Candidate
ordering across the union of both stores is score descending, `updatedAt`
descending (lexicographic ISO UTC ordering), scope (`global` before `project`),
then ID ascending. The `limit` applies *after* this cross-scope ordering, not
once per scope. The store API must expose its computed score internally (it
need not expose it in the public tool output) so the tool does not reimplement
matching differently. Equal IDs therefore remain two ordered candidates, not a
deduplicated record.

The current implementation searches all indexed records before applying its
limit. That property remains required: an older exact/content match cannot be
lost merely because a newer nonmatching record appeared earlier in the index.

#### Content snippet

Add `contentSnippet` only when `matchedFields` includes `content` and content
was successfully read. It contains source content, not a summary and not
normalized whitespace.

1. Find the smallest source UTF-16 position at which any query term matches
   case-insensitively. On equal position, use the earlier query-term order.
   The source-position mapping must be correct for Unicode lowercasing; do not
   use an index in a transformed lowercase string as an index into the source.
2. Center a window of at most 240 UTF-16 code units on that match. If content
   exists on either omitted side, reserve one code unit for `…` on that side.
   Prefer equal left/right context; an odd remaining unit goes to the right.
3. Move each cut outward as needed so it does not split a UTF-16 surrogate
   pair. This may make the returned source window shorter than the nominal
   limit. Prefix/suffix ellipses count toward the 240-code-unit bound.
4. Set `truncated` when either side was omitted. A content shorter than the
   window is returned unchanged with `truncated: false`.

If a record's metadata plus its bounded snippet cannot fit, omit the whole
result rather than shortening the snippet below this contract. This makes the
search excerpt deterministic at a given query, store, limit, and budget.

### 4.4 `memory_retrieve`

**Input**

```ts
{
  query: string; // same nonblank-term rule as memory_search
  limit?: integer; // effective configured default; 1..50 after clamp
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape**

```ts
{
  memories: Array<{ scope: 'global' | 'project'; memory: Memory }>;
  unavailableIds: Array<{ scope: 'global' | 'project'; id: string }>;
  omittedIds: Array<{ scope: 'global' | 'project'; id: string }>;
  omittedIdCount: number;
  unavailableIdCount: number;
  charsUsed: number;
}
```

`memories` and `unavailableIds` keep their current field names. `omittedIds`,
the counts, and `charsUsed` are additive. `unavailableIds` contains candidates
whose search result already had `available: false`, whose later `get()` was
null, or whose `get()` failed with `MemoryStorageError` or
`MemoryNotFoundError`. It does not turn one store's fatal index failure into a
per-memory unavailable result; that remains `storage_error` for the tool.

The candidate set and order are exactly the `memory_search` ranked union,
before output-budget omission. For each candidate in order:

1. If it is unavailable, append its `{ scope, id }` diagnostic when it fits;
   otherwise retain its generic unavailable count.
2. Otherwise load the memory. If it becomes unavailable during that read,
   append the unavailable reference.
3. If the complete `{ scope, memory }` object plus every required diagnostic
   and accounting field fits, append it to `memories`.
4. Otherwise append its reference to `omittedIds`; do not slice the memory.
   Continue visiting later candidates in rank order, so a later complete memory
   may still be returned after the earlier omission without reordering it.

This first-fit-in-ranking-order rule is intentional: retrieval relevance wins
over packing density, and makes an oversized first memory a visible omission
rather than surprising reordering. An individual complete memory larger than
the empty successful envelope is omitted in this tool; `memory_get` instead
exposes its content progressively.

Diagnostics participate in the same admission and are reserved before
memories. The capped input limit prevents unbounded diagnostic work. When an
individual hostile legacy ID, or a later diagnostic entry, cannot fit, omit
that descriptor and retain the exact generic `omittedIdCount` or
`unavailableIdCount`; counts include listed and unlisted IDs. This does not
turn a readable record into `output_budget_exceeded` merely because its legacy
identifier is hostile.

## 5. Local prior-session browser

### 5.1 Authority, source, and privacy boundary

The browser reads the local CLI conversation persistence owned by
`conversation-persistence`: canonical `*.jsonl` logs and the existing replay
path, including the existing delta-sidecar merge. It is not a gateway feature.
It must not read `source/gateway/persistence`, gateway SQLite/index state, or a
remote gateway transport, and it must not write any persistence record.

Create a narrow `SessionBrowser` service next to conversation persistence. Its
constructor receives a context supplier, not arbitrary model-supplied paths:

```ts
type SessionBrowserContext = { projectPath: string; sshHost?: string };
type SessionBrowser = {
  list(input: SessionListInput): SessionListResult;
  search(input: SessionSearchInput): SessionSearchResult;
  read(input: SessionReadInput): SessionReadResult;
};
```

The supplier evaluates the current `ExecutionContext.getCwd()` at each tool
execution. It also supplies the canonical SSH host captured by CLI startup;
this needs an explicit context field threaded from CLI/agent composition,
because `ExecutionContext` currently exposes an SSH service but not its host
identity. The host comparison must use the same trim/lowercase normalization as
`conversationMatchesProject()` and the CLI resume path. A local context has no
host and therefore cannot browse a remote session; a remote context requires
both matching project path and matching host.

The browser calls the persistence owner for context filtering and replay; it
does not duplicate raw JSONL parsing in a tool factory. A persistence-facing
enumeration helper may be added to distinguish valid, malformed, and unreadable
files without exposing filesystem paths or raw errors to the model.

Prior transcripts can contain user text, assistant text, tool arguments,
outputs, secrets, and material that is stale or untrusted. Browser results are
therefore ordinary tool output, never startup prompt material. No session body,
summary, snippet, or last-session record is automatically injected into the
main prompt, a subagent prompt, provider history, memory storage, or gateway
persistence. The model must explicitly call a browser tool. This feature adds
no new cross-user, cross-project, cross-SSH-host, or network access.

It does not promise redaction of historical transcript content. Existing
persistence is the privacy boundary: only a caller already permitted to run in
the same local user profile and current project/SSH context can request it.
Tool diagnostics must nevertheless never reveal local paths, raw parser
errors, lock payloads, or bytes from an out-of-scope session.

Enumeration ignores an unsafe filename rather than count it as unavailable:
without deriving a path from an unsafe identifier, the browser cannot prove
that file belongs to the current project/SSH context. Safe-name files that can
be context-checked but are unreadable or malformed contribute to
`unavailable`.

### 5.2 Transcript projection and matching kinds

The browser projects the `RestoredState.messages` produced by `replayEvents`.
It does not return raw `LogEvent`, `ProviderInputItem`, provider-opaque item,
tool ledger, request IDs, or log envelope fields. This avoids coupling the
browser's public contract to provider persistence and avoids exposing
unbounded opaque JSON.

Projection is deterministic and preserves message order:

| Replayed `sender` | Browser `kind` | `text` |
| --- | --- | --- |
| `user` | `user` | `message.text` |
| `bot` | `assistant` | `message.text` |
| `reasoning` | `reasoning` | `message.text` |
| `system` | `system` | `message.text` |
| `command` | `tool` | `message.command`, followed by `\n`, followed by `message.output` when nonempty |
| `subagent` | `subagent` | `message.task`, followed by `\n`, followed by `message.finalText` when present, including an empty string |

The projector includes all six kinds in `session_read` and `session_search`.
It does not expose command `toolArgs`, call IDs, or subagent internal tool
arrays. A record whose projected text is empty remains readable with `text: ''`
but contributes no search match. Unknown future message senders are skipped and
increment `skippedMessageCount`; they must never be coerced to an arbitrary
object string.

### 5.3 `session_list`

**Input**

```ts
{
  limit?: integer; // 1..50, default 10
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape**

```ts
{
  sessions: Array<{
    id: string;
    createdAt: string;
    updatedAt: string;
    firstUserMessage?: string; // deterministic 240-code-unit snippet
    model?: string;
    provider?: string;
    messageCount: number;
  }>;
  omitted: number;
  unavailable: number;
  charsUsed: number;
}
```

Only sessions matching the supplied project/SSH context are candidates.
`createdAt`, model, provider, and first-user text originate from `session_init`
and replay/list metadata; `updatedAt` uses the existing canonical log mtime
fallback semantics. Candidates order by `updatedAt` descending then `id`
ascending. `firstUserMessage` uses the same 240-character, surrogate-safe
prefix/ellipsis algorithm as a snippet (prefix rather than match-centered).

`messageCount` is the count of projected browser records, not the older
`listConversations()` display counter. This makes it agree with `session_read`.
The list builder admits complete session records in order and sets `omitted` to
the count that fit the requested limit but not the output envelope.

`unavailable` counts safe-name, in-scope `*.jsonl` candidates that cannot produce a
structurally valid `session_init`, cannot be read, or cannot be replayed. A
malformed or unreadable session is skipped, not fatal to other sessions. It is
not listed by ID because an unreadable file cannot prove a trustworthy session
identity and a malformed filename is not a public session identifier. This is
the deliberate distinction from memory retrieval, whose index has stable IDs.

### 5.4 `session_search`

**Input**

```ts
{
  query: string; // nonblank whitespace-delimited terms
  limit?: integer; // 1..50, default 10
  maxChars?: integer; // 512..12_000, default 12_000
}
```

**Success shape**

```ts
{
  results: Array<{
    sessionId: string;
    kind: 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'subagent';
    messageIndex: number;
    snippet: { text: string; truncated: boolean };
    updatedAt: string;
  }>;
  omitted: number;
  unavailable: number;
  skippedMessageCount: number;
  charsUsed: number;
}
```

Search examines every projected, nonempty text record in every eligible,
readable session before applying `limit`. Terms use the same whitespace split
and JavaScript-lowercase containment semantics as memory search. Score each
term once per matching record: an exact whole-text match is +100, a match at
the start of text is +20, and any other text containment is +2. Scores add
across terms. A record is eligible if total score is positive.

Order matches by score descending, session `updatedAt` descending, session ID
ascending, then `messageIndex` ascending. `kind` does not break ties because a
single message index has exactly one projected kind. Duplicate text in two
messages is intentionally two results. The snippet is the §4.3
match-centered content-snippet algorithm with `CONTENT_SNIPPET_CHARS`, using
the earliest source match and query-term order for ties.

`unavailable` and `skippedMessageCount` use the same meanings as
`session_list`. `omitted` counts ranked matching records that did not fit after
the result limit was chosen. Results never contain a partial snippet.

### 5.5 `session_read`

**Input**

```ts
{
  id: string; // safe opaque historical session ID
  cursor?: string; // opaque base64url cursor issued by this tool
  limit?: integer; // 1..50, default 20
  maxChars?: integer; // 512..12_000, default 12_000
}
```

`generateId()` uses `crypto.randomUUID()`, but reads accept existing safe
opaque IDs rather than require UUID syntax. The tool validates the historical
safe path-component grammar before path derivation and never uses an
unvalidated model-supplied string. This does not broaden the CLI resume
command's input surface.

**Success shape**

```ts
{
  session: {
    id: string;
    createdAt: string;
    updatedAt: string;
    model?: string;
    provider?: string;
  };
  items: Array<{
    index: number;
    kind: 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'subagent';
    text: string;
    textOffset: number;
    totalTextChars: number;
    complete: boolean;
  }>;
  nextCursor?: string;
  omitted: number;
  skippedMessageCount: number;
  charsUsed: number;
}
```

The read uses the same decoder, replay, and context check as resume through
`loadConversationForProjectReadOnly`, without resume's directory-creation and
legacy-migration side effects. A
missing session is `not_found`; a project/SSH mismatch is also `not_found` so
the tool does not confirm a foreign session's existence; an unreadable or
malformed in-scope session is `session_unavailable`. These error outcomes are
bounded and contain no raw persistence detail.

The initial position is `(nextIndex: 0, nextTextOffset: 0)`. `index` is the
zero-based replayed-message index before unknown-message skipping. Each item
starts at `textOffset`, has the source length in `totalTextChars`, and is
complete iff its text reaches that length. A full fitting message is emitted
with `textOffset: 0` and `complete: true`; a large message is emitted as a
surrogate-safe contiguous chunk, `complete: false`, then ends the page. Its
next cursor keeps the same index and advances `nextTextOffset` by
`text.length`. Empty text is emitted complete and advances the index. `limit`
caps records begun in one page; after a complete record, the browser may begin
the next record in source order. It never skips an earlier record for a later
one. `omitted` counts considered records not begun because the page bound was
reached, not records after the page.

A success page must contain a complete empty message or a nonempty text chunk;
the next cursor must therefore advance `(index, text offset)` lexicographically.
An implementation must reject/raise the bounded error rather than publish an
empty nonterminal page. Large session text is consequently fully reachable at
the maximum supported budget, never rendered inaccessible by a non-advancing
cursor.

#### Cursor format and stale semantics

The cursor is an opaque base64url encoding of canonical JSON:

```ts
{
  v: 1;
  sessionId: string;
  updatedAt: string;
  revision: string; // 96-bit base64url digest of the browser projection
  nextIndex: number; // non-negative safe position in projected records
  nextTextOffset: number; // non-negative safe integer in that record's text
}
```

Canonical JSON property order is exactly the order shown. The cursor contains
no transcript text. `revision` is the first 96 bits of SHA-256 over the
projected session identity, metadata, records, and skipped count; it detects a
transcript change even when two persisted events share the same timestamp.
The cursor is validated strictly after decoding: no extra fields, matching
`sessionId`, valid ISO timestamp string, canonical 16-character base64url
`revision`, and non-negative safe integers are required. Malformed base64url,
malformed JSON, version mismatch, extra fields, another session ID, or invalid
position yields `invalid_cursor`.

On every continuation, reread the session and compare both its current
`updatedAt` and projection revision to the cursor snapshot exactly. A different
value yields `stale_cursor` and no items. The caller restarts without a cursor;
it must not apply an old offset to a changed transcript. A deleted session is
`not_found`. The cursor is not a capability: authorization is rechecked against
current project/SSH context before parsing it.

After a complete item the cursor is the next position in the projected-record
array with offset zero; after a partial item it is that item's strictly larger
text offset. No cursor
is returned only after the final complete item. This cursor progress invariant
precludes an infinite non-advancing page.

## 6. Deterministic truncation algorithm

Implement one internal `fitSerializedEnvelope` helper for all results. It
performs the §2.1 character and UTF-8-byte checks on every prospective result:

1. Construct the required empty result including zero counts and the correct
   empty arrays. Serialize it with fixed-point `charsUsed`. If it cannot fit,
   return the bounded `output_budget_exceeded` error.
2. Visit candidates in the contract's declared order.
3. Construct a prospective result containing the complete next candidate and
   all required diagnostics/count changes; compute its fixed-point serialized
   length.
4. Admit it only when both caps fit. Otherwise make the contract-required
   omission/unavailable update and test that update as a new prospective result.
5. Publish the final fixed-point result and assert its measured character and
   byte lengths plus reported `charsUsed` agree.

For list/search/retrieve admission, implementations may reserve the largest
possible final omission/unavailable count while testing a candidate. This is a
deliberately conservative packing rule: it can omit a boundary-sized candidate
instead of depending on a one-digit count that later grows to two digits, but
it cannot admit a candidate and then invalidate the envelope when diagnostics
grow. The published counts remain the exact numbers actually omitted or
unavailable.

The helper accepts a pure clone/candidate builder. It must not mutate arrays
then attempt to roll them back, because an exception in a candidate serializer
must not leave a partially selected result. It must preserve array order, never
use iteration order from filesystem directory enumeration, and never use a
wall clock for tie-breaking.

All displayed source slices use a surrogate-safe UTF-16 slicer. It may reduce a
requested source range by one code unit at a boundary; it must never introduce
the replacement character by splitting a pair. This output validity rule is
separate from JSON escaping and does not alter the accounting unit.

## 7. Tool registration and prompt wiring

1. Keep memory tools in `createMemoryToolDefinitions`; evolve their Zod schemas
   and result construction there, with score/snippet support owned by
   `FileMemoryStore` or a memory-domain helper rather than duplicated tool
   matching.
2. Add `createSessionBrowserToolDefinitions` in a dedicated read-only tool
   module. It receives `SessionBrowser` and no filesystem directory, mutable
   persistence port, or gateway port.
3. Construct the browser in root agent composition with an explicit
   `{ projectPath, sshHost? }` supplier. Thread the startup SSH host from CLI
   through agent factory dependencies; do not infer it from `ISSHService`.
4. Register session browser tools only on the interactive root agent when local
   conversation persistence is available. They are not inherited by nested
   subagents, the librarian, one-shot/non-interactive mode, or gateway agents
   in this phase. Root-only describes registration, not data scope: every
   execution still applies the current project and SSH-host filter. This avoids
   widening transcript access merely because memory read authority was granted.
5. All three tools are `needsApproval: () => false`, have no `effect`, set
   `preserveSerializedOutput`, and are formatted as read-only
   transcript/browser commands. They never invoke
   `ConversationLogWriterImpl`, `saveLastConversation`, `deleteConversation`,
   `forkConversation`, or gateway persistence.
6. Update main-agent guidance to say that prior-session text is available only
   on demand through the session browser, is potentially stale/untrusted, and
   is not durable memory. Do not add browser tools to the initial persistent
   memory fragment or auto-inject a browser listing.

The root-tool-only decision is an authority boundary, not an optimization.
Future delegation requires an explicit role policy and a review of whether a
subagent may inspect a user's prior conversation text.

## 8. TDD acceptance examples

Write failing focused tests before each implementation phase. Tests must parse
the returned JSON and assert the actual `JSON.stringify(value).length`, not a
mocked payload-size field.

### Memory

1. **Search snippet and ranking:** create global/project records with the same
   score and timestamp and duplicate IDs. Assert global precedes project, both
   remain present, `contentSnippet` centers on the earliest content match,
   uses ellipses within 240 UTF-16 units, and does not split an emoji surrogate
   pair.
2. **Search budget:** use metadata that fits and a later record whose metadata
   plus snippet does not. Assert the first result is complete, `omitted` is
   exact, `charsUsed` equals serialized length, and output is within 512 and
   12,000 requested budgets plus the resolved UTF-8 byte cap.
3. **Retrieve complete-only:** rank a too-large memory first and a small one
   second. Assert the large record appears in `omittedIds`, the small record is
   not packed ahead of it, and no body substring appears. Then use a fit-sized
   first record and assert its complete body is returned.
4. **Retrieve unavailable race:** make search report two candidates, delete one
   before `get`, and assert it appears in `unavailableIds` while the other can
   still return. Assert duplicate IDs across global/project carry their scopes.
5. **List/get compatibility and paging:** existing assertions that read
   `{ scope, global, project }` and fitting `{ scope, memory }` remain true
   after ignoring additive fields. Read a giant memory over content cursors;
   assert its chunks concatenate byte-for-byte to its content, each cursor
   advances, and each response satisfies both character and UTF-8-byte caps.
6. **Escaping and fixed overhead:** use quotes, backslashes, newlines, and
   astral characters in every field. Assert candidate admission is based on
   `JSON.stringify`, including a boundary where adding one escaped character
   changes the decision.
7. **Legacy ID:** use an indexed valid overlong ID. Assert its diagnostic is
   omitted in favor of the exact generic count when it cannot fit, no hash or
   prefix reference is emitted, and a direct complete-ID `memory_get` remains
   accepted.

### Session browser

1. **Context isolation:** create local and remote sessions with equal project
   paths, different SSH hosts, and a second project. Assert a local browser
   sees only local same-project records; a remote browser sees only its same
   host/project records. Assert mismatch reads return `not_found`.
2. **No automatic injection:** build a root agent with persisted sessions and
   assert its prompt and initial provider input contain none of their text.
   Assert the three browser tools are present only in the root registry.
3. **Projection:** persist each supported replay message sender. Assert
   `session_read` maps all six kinds and excludes command `toolArgs`, call IDs,
   provider history, and opaque provider items.
4. **Search:** create equal score matches across kinds/sessions. Assert exact
   score ordering, `updatedAt` and ID tie-breaks, source message indexes,
   bounded match-centered snippets, and that empty projected text does not
   match.
5. **Cursor:** read a multi-page transcript including one oversized message;
   concatenate its offset-ordered chunks and assert the original text and order
   appear exactly once. Assert every nonterminal cursor advances by index or
   text offset. Mutate the log between pages and assert `stale_cursor`; pass
   malformed, cross-session, and extra-field cursors and assert `invalid_cursor`.
6. **Page budget:** make the first message larger than the requested budget.
   Assert a nonempty partial chunk, advancing same-message offset, bounded
   UTF-16/UTF-8 serialized result, and eventual complete reachability. Assert a
   fitting item is complete and is never string-truncated.
7. **Malformed/stale persistence:** include invalid JSON lines, a log without
   valid `session_init`, an unreadable candidate, and a deleted session. Assert
   list/search continue with truthful unavailable counts, valid lines retain
   the existing decoder/replay tolerance, and direct read errors are sanitized.

Run focused tests for the memory store/tools/capabilities and conversation
persistence/session browser first. Because wiring changes the root agent tool
registry, also run its focused agent and tool-policy tests. No provider
black-box run is required unless the implementation expands into provider,
bridge, run-loop, registry, or non-interactive code.

## 9. Phased implementation

### Phase 1 — shared serialization boundary

Add dual UTF-16/UTF-8 serialized-envelope admission, fixed-point `charsUsed`,
surrogate-safe slicing, opaque cursor validation, and tests independent of
storage. Do not change tool registration yet.

### Phase 2 — memory search and retrieval

Extend the memory domain contract with internal scoring/snippet information;
apply cross-scope ranking; then implement bounded `memory_search`, complete
only `memory_retrieve`, and progressive `memory_get`. Preserve
stale/unavailable handling already present in `createMemoryToolDefinitions`.

### Phase 3 — compatible list/get settlement

Add only the additive accounting and bounded selection needed to make
`memory_list` obey the universal response boundary; update memory tool and
capability tests plus guidance descriptions.

### Phase 4 — persistence-owned session browser

Introduce the narrow persistence-facing browse API and `SessionBrowser` with
context filtering, transcript projection, malformed-file classification, and
cursor validation. Add unit tests using the existing conversation-directory
test override rather than a real home directory.

### Phase 5 — root wiring and authority proofs

Thread canonical SSH context through root agent construction, register the
three browser tools only where authorized, add display formatters/prompt
guidance, and prove no transcript is auto-injected or delegated accidentally.

### Phase 6 — regression gates and documentation review

Run the focused suites named above, then the relevant broader root-agent test
gate. Re-read this document against the implemented symbols, update its status
only when implementation lands, and record a merge commit only after one
exists.

## 10. Out of scope

- Writing, deleting, editing, summarizing into, or automatically promoting a
  session transcript to persistent memory.
- Auto-resume, auto-injection, semantic recall, RAG/vector search, embeddings,
  token-count estimation, or model-selected hidden transcript context.
- Searching gateway sessions, provider traffic, shell history, CLI history,
  logs outside conversation persistence, another OS user, or remote filesystem
  conversation files.
- Gateway persistence schema/API changes, synchronization of local sessions to
  a gateway, and any network transport for browser tools.
- Changing the conversation JSONL version, replay semantics, sidecar lifecycle,
  resume/fork/delete behavior, or provider-opaque persistence.
- Adding browser authority to subagents, librarians, non-interactive calls, or
  other roles without a separate authority design.
- Redacting or repairing historical transcript secrets. The feature must avoid
  new diagnostic leaks, but a broader secret-at-rest/redaction policy is a
  separate decision.

## 11. Resolved decisions

| Question | Decision |
| --- | --- |
| What is bounded? | The full serialized JSON tool result, by requested UTF-16 `maxChars` and the resolved UTF-8 tool-result cap, not just document text or estimated tokens. |
| What if one memory is too large? | `memory_retrieve` records it as an omission in rank order; `memory_get` exposes its content in cursor pages and preserves the old success shape only when it fits. |
| What if the first transcript item is too large? | Return a nonempty content chunk and an advancing same-message text offset; do not skip it or emit a non-advancing page. |
| How are duplicate memory IDs handled? | Scope is identity for search/retrieve; global-first lookup remains only for compatible `memory_get`. |
| How do references fit if a legacy ID is huge? | Do not synthesize a reference. Omit the descriptor and retain the exact bounded generic omitted/unavailable count; direct legacy get remains accepted. |
| How are malformed sessions handled? | Listing/searching skips them with unavailable counts; a requested in-scope malformed/unreadable session returns sanitized `session_unavailable`. |
| Which message kinds match? | All six projected kinds: user, assistant, reasoning, system, tool, and subagent. Raw provider/tool internals are excluded. |
| How are stale reads handled? | Cursors pin identity/version and the next content offset; any changed transcript/memory returns `stale_cursor` and requires restart. |
| Does this inject old text into a model automatically? | No. Only explicit tool calls return session text; tool outputs remain ordinary visible tool results. |
| Does this integrate gateway persistence? | No. It is local CLI conversation persistence only. |

There are no unresolved product decisions within this specification. Implementation-level discoveries that contradict the live owner contracts must stop the relevant phase and update this document before widening scope.
