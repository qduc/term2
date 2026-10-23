# Code Context Tools for term2 (v1)

## Goal

Two tools to cut multi-turn grep/find exploration:

- `read_code_outline(path)` — structural outline of one file
- `code_context_search({query_type, path?, symbol?})` — JIT related-files or symbol search

Just-in-time, ripgrep-backed. No persistent index, no LSP, no embeddings, no summaries, no JSON. All output is plain text. The agent must still call `read_file` before editing behavior.

---

## read_code_outline

Returns imports, exports, and top-level declarations with line numbers. No bodies.

```
FILE source/tools/read-file.ts
LANG typescript

IMPORTS
zod: z
fs/promises: readFile
./utils.js: resolveWorkspacePath relaxedNumber

EXPORTS
type ReadFileToolParams line=18
function createReadFileToolDefinition line=41

DECLARATIONS
const readFileParametersSchema line=8
function createReadFileToolDefinition line=41 exported
```

Empty sections print `EMPTY`. Unknown languages return `LANG unknown` with empty sections rather than failing.

**Declaration kinds:** `function | class | interface | type | enum | const | let | var | method | unknown`

**Languages:** TS/JS primary; Python, Go, Rust best-effort; everything else → `unknown`.

**Import shapes to handle (TS/JS):** default, named, namespace, type-only, side-effect, re-export, `export *`, dynamic `import()`, `require()`.

---

## code_context_search

```ts
code_context_search({
  query_type: "related" | "symbol",
  path?: string,        // required when query_type = "related"
  symbol?: string,      // required when query_type = "symbol"
  max_results?: number  // default 20
})
```

### related output

```
QUERY related
TARGET source/tools/read-file.ts

source/tools/read-file.test.ts
REL likely_test

source/tools/index.ts
REL imported_by_target barrel_export
```

Empty → `NO_RESULTS`.

### symbol output

```
QUERY symbol
SYMBOL createReadFileToolDefinition

source/tools/read-file.ts:42 function createReadFileToolDefinition exported
```

Empty → `NO_RESULTS`.

---

## Relation vocabulary (fixed)

| Token | Meaning |
|---|---|
| `imports_target` | target imports this file |
| `imported_by_target` | this file imports or re-exports target |
| `barrel_export` | this file is a barrel re-exporting target |
| `likely_test` | filename pattern matches test for target |
| `likely_source_for_test` | target is a test; this is the source under test |
| `same_directory` | sibling of target (capped at 5) |
| `package_entry` | referenced in `package.json` (main/module/exports/bin/types) |
| `config_reference` | referenced in tsconfig / vite / eslint / jest / vitest configs |

One file may carry multiple tokens; merge them on a single `REL` line. No reason or confidence fields.

---

## Ranking

**Related:** `likely_test > likely_source_for_test > imports_target > imported_by_target > barrel_export > package_entry > config_reference > same_directory`. A file's strongest token sets its sort key.

**Symbol:** exported exact > non-exported exact > method-like exact > case-insensitive exact > prefix > substring. Fall back to call sites only when no declarations exist; mark them `kind=unknown`.

---

## Related algorithm

1. Read target. Parse local imports (`./...`, `../...` only).
2. Resolve each: try `.ts .tsx .js .jsx .mts .cts .mjs .cjs .json`, then `index.*`. Resolved → `imports_target`. Unresolved package imports (e.g. `react`, `zod`, `fs/promises`) dropped.
3. Build the specifiers other files might use (`./read-file`, `./read-file.js`, `../tools/read-file`, etc.). Ripgrep for `from "..."`, `import("...")`, `require("...")`, `export ... from "..."`. Hits → `imported_by_target`. A file whose only job is re-export → add `barrel_export`.
4. Test detection by filename pattern:
  - `foo.ts` → look for `foo.test.ts`, `foo.spec.ts`, `__tests__/foo.test.ts`, `tests/foo.test.ts` (and `.tsx` / `.js` / `.jsx` variants).
  - If target is a test → reverse the pattern; if the test imports a local file, mark `imports_target likely_source_for_test`.
5. Same-directory: capped at 5, only after stronger relations. Exclude `.map`, generated, binary, oversized.
6. Package / config references: cheap lookups, optional.
7. Dedupe, merge tokens per file, rank, emit.

---

## Symbol algorithm

1. Validate symbol is identifier-safe (no regex injection).
2. Ripgrep declaration patterns per language:
  - **TS/JS:** `(export\s+)?(function|class|interface|type|enum|const|let|var)\s+<symbol>`
  - **Python:** `(def|class)\s+<symbol>`
  - **Go:** `(func|type)\s+<symbol>`
  - **Rust:** `(fn|struct|enum|trait)\s+<symbol>`
3. Classify kind from match. Mark `exported` if `export` keyword present (or uppercase initial in Go).
4. Dedupe, rank, emit.

---

## Language support

Per-language behavior is dispatched through a `LanguageProvider` interface so adding a language is a new provider, not a patch across the search code.

```ts
interface LanguageProvider {
  language: string
  matches(path: string): boolean

  // Required — used by symbol search
  declarationPatterns(symbol: string): RipgrepPattern[]
  classifyMatch(line: string): { kind: DeclarationKind, exported: boolean }

  // Optional — used by outline + related search
  extractOutline?(source: string): { imports: Import[]; decls: Decl[] }
  resolveImport?(specifier: string, fromPath: string, root: string): string | null
  testPatterns?(path: string): { forSource: PathPattern[]; forTest: PathPattern[] }
}
```

A provider implementing only the required methods supports symbol search. Outline and related search require the optional methods; if absent, those tools emit `WARNING unsupported_language` and degrade gracefully (outline returns `LANG <name>` with empty sections; related returns `NO_RESULTS`).

v1 providers:

- **TS/JS** — full: outline, import resolution, test patterns, declarations.
- **Python, Go, Rust** — declarations only.

No shared `Import` or module-resolution model across languages. Each provider returns its own normalized shape for display; the output format (plain text, free-form `kind` string, line numbers, fixed `REL` tokens) is language-neutral by design and does not change as providers are added.

The per-language regex listed in the Symbol algorithm above are the v1 provider implementations, not part of the dispatch contract.

---

## Safety & limits

- Path must resolve inside the workspace; reject otherwise.
- Skip: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.cache`, `out`, `vendor`. Honor `.gitignore` when practical.
- Skip binaries.
- Max target file: 512 KB. Max files searched: 10,000. Default `max_results`: 20.

---

## Warnings

Top-level only, one line: `WARNING <code>`. No per-result noise.

Codes: `partial_search`, `target_too_large`, `unsupported_language`, `rg_unavailable`, `result_limit_reached`.

---

## Tool descriptions

**`read_code_outline`** — "Compact outline of one file: imports, exports, declarations. No bodies. Use `read_file` before editing."

**`code_context_search`** — "Bounded just-in-time search for related files (by path) or symbol declarations (by name). Plain text, fixed relation tokens. Use `read_file` before editing."

---

## Acceptance criteria

1. Find a symbol's declaration in one call.
2. Find a file's likely tests, importers, and local imports in one call.
3. Inspect file shape without reading the full body.
4. Symbol search works for TS, JS, Python, Go, and Rust via the provider interface.
5. Adding a new language requires only a new `LanguageProvider`; no edits to search/dispatch code.
6. Output is compact, deterministic, low-noise.
7. No persistent index required.
8. Agent does not edit behavior on outline/search results alone.
