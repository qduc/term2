# Native catalogue + session_search author evidence

## Revision and scope

- Base: `62566bb7`.
- Production commit tested: `d4fa3866` (`feat(rewrite): add native contentless search catalogue and indexed discovery`).
- Worktree/branch: `rewrite/m6-native-search-20261101`.
- Verification below ran after the production commit, with no production edits.
  Temporary probes and synthetic artifacts remained untracked in this directory.
- Independent acceptance is separate and has **not** been performed by this author.

Implemented the app-owned sibling SQLite FTS5 contentless catalogue, native public
transcript projection, app-owned `session_search` Tool, optional Session capability
registration, and catalogue-backed CLI `--resume ls/last`. The maintained interface
is `rewrite/src/app/native-catalogue.md`; the app README links it. No source files,
native log formats/reference kinds, default/candidate routing or legacy stores
were changed. No source store/provenance/map/runtimelegacy data was read.

The supplied prior private-copy R10 measurement (28.8613%, 4,455,735 / 15,438,441
for three migrated sessions, all eight accounted) was an input, not rerun here.
All data used for this implementation's author checks was synthetic.

## Commands and outcomes

Installation and builds:

- `pnpm install --frozen-lockfile`: passed; independent local `node_modules`, no symlink.
- `pnpm build`: passed (root product build, earlier dirty production snapshot).
- `node rewrite/scripts/build.mjs`: passed on the committed production revision;
  this is the native build used for every final probe and CLI spawn.

Final static checks:

- `pnpm typecheck`: passed.
- `pnpm exec tsc --noEmit -p rewrite/tsconfig.json`: passed.
- `node rewrite/scripts/check-layers.mjs`: passed, 522 existing allowlisted source edges.
- `pnpm check:no-unit-tests`: passed; no permanent tests added.
- `git diff --check`: passed before commit.
- Prettier check of all eight owned production files: passed.
- Effective scoped ESLint: passed with zero errors and one pre-existing warning,
  unused `DirectGoalState` in `direct-capabilities.ts`.

The effective lint command was:

```sh
pnpm exec eslint --config .evidence/m6-native-search/eslint.config.mjs \
  rewrite/src/app/native-catalogue.ts rewrite/src/app/native-transcript.ts \
  rewrite/src/app/native-search.ts rewrite/src/app/cli-conversations.ts \
  rewrite/src/app/direct-application-runtime.ts rewrite/src/session/direct-capabilities.ts
```

The untracked config preserves the repository rules, removes the rewrite global
ignore and points project parsing at `rewrite/tsconfig.json`. The ordinary root
ESLint invocation ignores rewrite files; `--no-ignore` instead fails because the
existing config references absent `packages/core/tsconfig.json`. This is **scoped
lint evidence**, not a claim that full `pnpm lint` passed.

Native persisted-data checks:

```sh
node .evidence/m6-native-search/probe.mjs
node .evidence/m6-native-search/capability-probe.mjs
node .evidence/m6-native-search/baseline.mjs
```

All passed on `d4fa3866`. Machine summaries are the untracked `probe-result.json`,
`capability-result.json` and `baseline-result.json` beside this report.

### Actual product CLI/tool loop

```sh
/home/qduc/coord/term2/tasks/direct-engine-rewrite/m6-serial-goldens-evidence/fenced-run.sh \
  node .evidence/m6-native-search/cli-probe.mjs
```

Passed on `d4fa3866`: three launches (`--resume ls`, fresh headless tool turn,
`--resume last` continuation), three loopback provider requests. OS network
namespace `net:[4026532832]` had only loopback and no default route. Every child
had private HOME/XDG/temp/settings/conversation directories. Before **every**
spawn the harness resolved the settings directory and instantiated the actual
app SettingsService, asserting its selected provider/model and loopback base URL.
The persisted fixture's model was also `search-mock/mock-search`, not a live
historical selection. No help or negative CLI was spawned outside this fence.

The mock inspected the normal provider tool offer, requested the actual named
`session_search`, and observed its real tool result in the next model request:

```json
{
  "total": 1,
  "hits": [{
    "sessionId": "conv_01234567-89ab-cdef-0123-456789abcdef",
    "identity": "message:original-note",
    "seq": 2,
    "kind": "user",
    "snippet": "ORCHID PRIVATE SYNTHETIC NOTE"
  }]
}
```

The CLI then returned `NATIVE_SEARCH_EXECUTED`. The indexed source conversation's
bytes were unchanged. Final CLI fixture/captures are under
`cli-synthetic-qfRzP4/`; `cli-result.json` records the summary.

## R9 measurements and behavior

The persisted-log probe used eight physical files initially: two matching healthy
lineages, other healthy content, another workspace, an SSH binding, another local
client binding, and an unrelated corrupt file. It instrumented native filesystem
reads and JSON parsing of accepted envelopes with `seq > 1`.

| Operation | Log reads | Non-header envelope parses | Parsed bodies |
| --- | ---: | ---: | --- |
| Warm listing | 0 | 0 | none |
| Warm search, two matching lineages | 18 | 6 | matching logical IDs 1 and 2 only (5 + 1 envelopes) |
| Append to logical ID 1, then listing refresh | 10 | 6 | affected logical ID 1 only |

The nonmatching physical logs were read only by the existing strict reader's
header discovery (twice for two matched lineages, once for append refresh), not
parsed as transcript bodies. This preserves the explicitly permitted existing
all-file-byte header-discovery I/O limitation; it does **not** claim zero unrelated
byte reads on search. Listing needs no transcript text or previews.

The same probe verified:

- Native imported observations plus ordinary user, assistant and reasoning items;
  tool/system observations, ordinary approval, subagent task/result and notice text.
- Kind filters and literal OR terms, including punctuation/quotes/operator-looking
  input without raw MATCH syntax injection.
- Hidden provider-context item and empty hidden restoration input excluded.
- Different workspace, SSH target/binding, and another local client binding excluded;
  an explicitly matching SSH catalogue scope returned its own synthetic hit.
- Source native log SHA-256 hashes unchanged by indexing/search and cache rebuild.
- Cache deletion/rebuild returned identical structured hits.
- Append invalidation touched only its logical body; same-length physical replacement
  invalidated the old term and indexed the new one.
- Real `createDirectRollingLog` physical rotation retained one catalogue identity,
  exposed the successor's current projection and removed predecessor-only text.
- Default `history_replaced` removed nonretained messages; `retainTranscript: true`
  kept the visible successor message.
- Log deletion removed hits. An unrelated corrupt sibling remained unavailable
  without denying healthy catalogue/search operations.
- Cache file mode 0600; private fixture parent mode 0700; contentless FTS DDL,
  `SELECT text FROM search` returning NULL, and metadata tables lacking text,
  content, snippet or preview columns. No full-text copy table.
- Overwriting the closed cache with non-SQLite bytes recovered by reconstruction.

The capability probe additionally checked Session registration/executable registry,
retention through the existing configuration rebind, sessions-slot revocation and
restoration, schema rejection of model-selected workspace/oversized result count,
and rejection of execution with a foreign workspace target.

## Baseline failures and limits

`node rewrite/scripts/check-complexity.mjs` fails on ten existing files. The
baseline probe loaded each from `62566bb7` and asserted byte equality with the
tested checkout, as well as matching the exact failure set:

- `app/cli.ts` 529; `app/direct-subagent-tools.ts` 584;
- `clients/headless/direct.ts` 900;
- `engine/turn-model.ts` 589; `engine/turn-tools.ts` 502;
- `host/server-events.ts` 519; `protocol/direct-wire.ts` 834;
- `session/conversation.ts` 1728; `session/log-facts.ts` 830; `session/replay.ts` 837.

The root ESLint missing-project reference and unused-import warning were also
confirmed in the base. `git diff 62566bb7 -- source` was empty. These failures
were not repaired or hidden by budget/config changes.

No full test/provider suite, paid API, private/live dataset, SSH connection,
external network beyond fenced loopback, push, publish or deploy was used.
The focused provider CLI scenario above supplies product-loop evidence rather
than claiming the full provider tier passed. Real generation reconfiguration was
not driven through a second CLI settings workflow: the existing rebind and
Session gate were exercised directly. Independent acceptance remains pending.

Design friction: none requiring a wider reshape. Listing deliberately drops
text previews to remain metadata-only. Search is a direct native Tool rather
than a fake source SessionBrowser. The existing all-byte header scan remains a
documented performance limitation. SQLite cache reconstruction is disposable,
not a new authoritative store, watcher, daemon or retry mechanism.

The worktree is left idle for supervisor report-preserving cleanup. Temporary
probe scripts/results are untracked; only production changes and this report
are committed.
