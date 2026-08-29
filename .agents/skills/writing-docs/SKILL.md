---
name: writing-docs
description: How to write documentation in this repo so it stays true as the code moves — scoping claims to what they are actually true of, recording why over what, and the conventions for plan status headers and code citations. Use when adding or editing AGENTS.md, CONTEXT.md, a skill, a contract doc, or a plan's status header, and when a code change makes an existing doc wrong.
---

# Writing Docs

Docs in this repo are read by agents as authoritative before they touch code. A false statement here does not merely mislead — it gets acted on. Write for the reader who will change behavior based on the sentence.

The companion rule for *reading* these docs is in `AGENTS.md` under "How to read the docs in this repo". This skill is the write-side counterpart: how to produce a doc that degrades gracefully instead of becoming a trap.

## The one failure that matters most

**Scope every claim to what it is actually true of.** A claim true of one component, one provider, or one lane, stated as a system-wide invariant, is the dominant defect class in this repo's docs. It is not carelessness — it happens because the author was correct at the time, when only one implementation existed. The second implementation arrives and the sentence silently becomes a lie.

Real examples found in an audit of this repo:

| Written as | Actually true of |
| --- | --- |
| "`breakChaining()` permanently switches the session to full history" | `ProviderContinuity` only — the Codex provider keeps a separate response-id map and re-arms on the next response |
| "Responses splices only `provider === 'openai'`" | The opaque *lane tag*, which is a parameter — Grok has its own |
| "The logger reassembles chunks into one OpenAI-style object" | The `chat_completions` wire shape only — the `responses` shape has no `choices` at all |

Each was accurate when written. Each became false when a second case appeared.

So: name the thing the claim holds for. "`ProviderContinuity` stops chaining" costs three words more than "chaining stops" and survives the next provider.

**Absolutes are the tell.** Before writing "always", "never", "only", "permanently", "all", or "for all subsequent", ask whether you verified it across every implementation or just the one in front of you. If it was one, scope it to that one.

## Record why, not just what

The code already states what it does, and states it more accurately than you will. What the code cannot record is **why**, and especially **what was tried and rejected**.

This is why a stale doc is still worth reading: its facts may have decayed, but its rationale usually has not. A note saying "we do not use `generate:false` warmup here because it bought a serial round trip while the paired call still reported `cached_tokens: 0`" stays valuable for years, and stops the next person re-deriving a dead end.

When you remove or rewrite a claim, keep the rationale attached to it. Deleting a "why" is a regression even when the replacement text is true.

## Cite symbols, not line numbers

Line-number citations (`file.ts:123`) drift silently and nothing catches them. An audit of this repo found every anchor in one skill had moved by 100–500 lines.

Prefer a **greppable symbol name** — `#rememberCodexResponseId()` in `codex-responses-model.ts`. It survives edits above it, and when it does break it breaks loudly: the grep returns nothing.

Use a line number only alongside a symbol name, never instead of one.

## Plan status headers: a merge commit or nothing

`AGENTS.md` instructs agents to read a plan's "Resume here" before touching the area it covers, so a stale header costs a whole session. The audit found seven headers claiming "not implemented" or "awaiting merge" for work already in `main`.

State a **merge commit sha** or say nothing about status. Never describe a branch as though it were the repo — "done in the `foo` worktree" becomes unverifiable the moment that worktree is removed.

## Run your recipes

Any documented command, `jq` query, or snippet must be executed before it ships. The audit found ~10 documented `jq` recipes that returned `null` on three of four provider lanes, because the payload shape had changed underneath them.

If a recipe depends on a shape that varies, say which shape it assumes and how the reader can tell which one they have. A `jq` query against a missing path returns `null` with exit code 0, so a wrong recipe reads as "the field is absent" rather than as an error — that is why running it is not optional.

## Prefer claims that fail loudly

A vague sentence is not safer than a wrong one; it is worse, because it cannot be caught. "The provider handles continuity appropriately" can never be falsified, teaches nothing, and will still be there in a year.

Write the specific, checkable claim instead. If it goes stale, someone's grep or test will catch it. Rot that is visible gets fixed; rot that is unfalsifiable accumulates.

## When a code change makes a doc wrong

Fix it in the same change. Search for the affected symbol across `AGENTS.md`, `CONTEXT.md`, `.agents/skills/`, and `docs/contracts/` before you consider the work done:

```bash
grep -rn "symbolName" AGENTS.md CONTEXT.md .agents/skills/ docs/contracts/
```

Make the smallest edit that restores truth. Do not reformat, restructure, or improve surrounding prose — an unrelated rewrite buries the correction and makes review harder.

If you cannot verify whether a nearby claim is still true, leave it and say so. Never replace a claim you did not check; a confident rewrite that is also wrong launders a guess into documentation, which is strictly worse than the stale text it replaced.
