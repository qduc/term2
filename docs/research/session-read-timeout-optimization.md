# Explicit session-read timeout: diagnosis and bounded optimization

Observed on Linux/Node 24.19.0 on 2026-10-24, against a roughly 2.1 GiB local
conversation directory. Measurements below use source modules loaded through Jiti;
they are not installed-CLI or production latency guarantees.

## Failure and cause

At 17:27:54 +07, session `1080e50a-f801-4bc4-a85e-527f83efc850` recorded a
20,364 ms `run_code` timeout while reading exact session ID
`63a75839-da34-4e25-b93c-a22d6f774c0f`. The persisted result included
`tools.session_read failed: Session index worker request timed out after 10000ms`.
A retry completed in 234 ms.

`SessionBrowser.#readIndexed` resolved references through the search index. Its
service reconciled the entire source directory before resolution. On failure it
used the canonical worker, whose reference resolution also replayed the entire
directory. A cold index could therefore consume one worker deadline followed by
another in fallback. A scratch-index reproduction failed after 20,647 ms with the
same worker error; it did not modify the live index.

The canonical path's filesystem counter observed **1,050 JSONL reads** for the
one-session request. The target log itself was approximately 3.3 MB. Output limits
and `kinds` selection did not prevent unrelated logs being decoded and replayed.

## Change and preserved boundaries

Explicit initial reads now use the canonical worker without first building or
refreshing the search index. Canonical reference resolution filters filenames
before replay, retaining the reference's first eight characters (or the whole
reference if shorter). Eight is the minimum UUID short-reference length: keeping
the full collision bucket preserves ambiguity and unique short refs. Candidate
logs still pass the existing decoder, project/SSH checks, and browsability checks.

Canonical `f` cursors stay with their owning worker and retain source-version
invalidation. Existing indexed `c` cursor continuations keep their indexed path.
`previous`, list, and search still use their existing full-catalog behavior;
**this repair does not eliminate their cold-index costs**. No deadline or persisted
format changes were made. Explicit initial reads replay the candidate log even
when an existing search index is warm; this trades that index reuse for independence
from unrelated corpus work. Very large individual logs or collision buckets can
still be slow.

## Measurements

Same immutable target and request: `kinds: ['user', 'assistant']`, `limit: 15`,
`itemMaxChars: 4000`, `maxChars: 18000`. Other sessions remained live, so host load
and corpus contents were not frozen. These are repeated local observations, not
population percentiles.

| Path | Before (ms) | After (ms) |
| --- | --- | --- |
| Canonical read, three calls | 25100.66, 25252.35, 23917.63 | 70.93, 48.69, 53.38 |
| Fresh worker and scratch-index service | timeout at 20646.52 (one call) | 711.06, 683.83, 649.48 |
| Diagnostic JSONL reads | 1050 | 1 |

Canonical median fell from 25,100.66 to 53.38 ms. All six canonical outputs had
175 total records, 15 returned items, short ref `63a75839`, and identical SHA-256
`364d3a5a7aba2c08cf813fe19fe9b115be5bbea31bde5cd17372e8f27b3a5015`
with the opaque `nextCursor` omitted. All three optimized cold-worker calls
completed without creating an index database. Instrumented read-count runs were
separate from the timings in the first row.

## Prevention and limits

The system weakness was coupling exact retrieval to full-corpus maintenance, not
an insufficient timeout. Small fixture corpora did not expose that cost. The
persisted-session integration regression exercises the real worker and filesystem,
checks collision ambiguity, scope rejection, cursor continuation, absence of index
creation, and that unrelated files are not read. The assertion on unrelated reads
would reject the old canonical implementation even on a small fixture.

The index remains derived from canonical logs; there is no evidence of data drift
or loss. List/search and `previous` are sibling full-catalog paths, not optimized
here because they need catalog-wide selection. The introducing revision and total
lifetime of the scaling defect are unknown. The October 5 worker repair preserved
full-directory replay while removing it from the UI thread; worker isolation alone
was not a latency bound.

Raw local evidence and reproduction scripts are retained under
`.cache/session-read-speed-results/` in the primary checkout. Scripts are stored as
`.cjs.txt` to avoid linting diagnostic artifacts; run from the worktree with
`node - < path/to/script.cjs.txt`. Do not add `--input-type=commonjs`: that flag is
inherited by the eval worker and breaks its module bootstrap. Final verification
commands and outcomes are archived at `42724797:docs/test-results.json`; the
causal findings and reproduction constraints above remain the useful reference.
