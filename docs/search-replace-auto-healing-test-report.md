# Search-Replace Tool Auto-Healing Test Report

**Date:** 2026-05-12
**Tool:** `search_replace` (CLI coding assistant tool)
**Subject:** Existence and tolerance of automatic search-content correction ("auto-healing")

## Summary

The `search_replace` tool has an auto-healing mechanism that activates when the search
content does not match exactly. It reports one of three outcomes:

- `healed: false` — exact match found, no correction needed.
- `healed: true` — auto-healing corrected minor differences and the match succeeded.
- `"Auto-healing attempted but no match found."` — healing tried but could not locate
  the content within its tolerance.

## Test Results

### Test 1 — Single-character deletion (short context)

| Aspect | Detail |
|---|---|
| **Search** | `- 🌍 **Open Souce**` (missing `r`) |
| **Actual** | `- 🌍 **Open Source**` |
| **Context length** | 1 line |
| **Result** | ❌ Not found. Auto-healing attempted but failed. |

### Test 2 — Exact match (control)

| Aspect | Detail |
|---|---|
| **Search** | Exact copy of a table row |
| **Result** | ✅ Found exactly. `healed: false` |

### Test 3 — Truncated line with `<...>` gap matching

| Aspect | Detail |
|---|---|
| **Search** | Table row truncated mid-line, then `<...>` to skip columns |
| **Context length** | 6 lines (2 visible + `<...>` gap) |
| **Result** | ✅ **Found with healing.** `healed: true` — _"minor differences"_ |

### Test 4 — Single-character deletion (longer context)

| Aspect | Detail |
|---|---|
| **Search** | `❓ **Challenges asumptions**` (missing `s`) with 3 surrounding lines |
| **Context length** | 4 lines |
| **Result** | ❌ Not found. Auto-healing attempted but failed. |

### Test 5 — Missing space between words (long context)

| Aspect | Detail |
|---|---|
| **Search** | `reconnaissanceand` (space removed) within a ~300-char paragraph |
| **Context length** | 5 lines |
| **Result** | ❌ Not found. Auto-healing attempted but failed. |

### Test 6 — Exact text with `<...>` gap matching (long context)

| Aspect | Detail |
|---|---|
| **Search** | Two partial paragraphs separated by `<...>`, content exact |
| **Context length** | 10 lines (3 visible + `<...>` gap) |
| **Result** | ❌ Not found. (Why? Possibly whitespace changed from an earlier healed edit.) |

## Conclusions

### What auto-healing can handle

1. **Minor line-boundary truncation** when combined with `<...>` gap matching.
2. **Whitespace differences** around gap markers (leading/trailing space alignment).

### What auto-healing cannot handle

1. **Spelling errors** — even a single missing character (`Souce` vs `Source`,
   `asumptions` vs `assumptions`).
2. **Merged words** — even a single missing space (`reconnaissanceand` vs
   `reconnaissance and`).
3. **No fallback strategy** — when healing fails, the only suggestion is _"Try
   splitting changes into smaller patterns."_

### Recommendation

- The `<...>` gap-matching syntax is the **intended and reliable mechanism** for
  skipping uncertain or truncated content in search strings.
- Do **not** rely on auto-healing to fix typos or spelling mistakes — it will not.
- If a search fails unexpectedly, verify the exact content in the file (the tool
  does not show what it attempted to match after healing).
