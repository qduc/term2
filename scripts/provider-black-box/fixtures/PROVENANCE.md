# Real-traffic fixture provenance

These are sanitized, reviewed wire envelopes. Raw recordings are never committed.
Replay fixtures validate captured provider behavior; they do not replace live canaries
for changes after capture.

> **Status: OpenAI Responses HTTP, OpenRouter AI SDK, Google GenerateContent,
> OpenCode Chat Completions, and OpenCode Go Anthropic pilots complete.** The reviewed
> real captures cover two-turn tool continuations through registry paths.
> The pre-capture `framesFor('responses')` helper was not wire-equivalent: it omitted
> reasoning/item lifecycle, function-argument, and terminal event shapes beyond its
> minimal synthetic success case. Synthetic frames remain for mutations and providers
> without an accepted live capture. The generic `chat-pilot.json` remains synthetic;
> the live OpenCode Chat Completions path is covered by
> `opencode/tool-continuation-v1.json`.

## Remaining live captures

- **Generic Chat Completions fixture** — `chat-pilot.json` remains hand-authored; decide
  whether replacing it adds value now that the live OpenCode chat path is covered.
- **Direct Anthropic API** — remains optional and credit-gated; Anthropic wire
  coverage is provided by `opencode/tool-continuation-v1-anthropic.json` captured via
  OpenCode Go.
- **Responses WebSocket/Codex WebSocket** — replay server coverage is synthetic; a
  live bidirectional `ResponsesWS` capture adapter remains outstanding.
- **OpenRouter maintenance** — the accepted fixture is large due to extensive model
  reasoning deltas. Retain or recapture with a shorter approved model after review;
  do not delete it without equivalent semantic coverage.

- **fixture/fake_chat-completions_success.json** — recorded from the fake provider via
  `provider:record --from-fake chat-completions success`; SDK `fixture-fake-provider`@1.0.0
  (never a real SDK — the drift test skips it); probe `fake:chat-completions:success`;
  reviewer fixture maintainer. Recapture when the record/replay machinery changes, not on
  SDK bumps.
- **fixture/chat-pilot.json** — synthetic pilot fixture exercising the Chat Completions
  registry path (`provider-contract.test.ts`); SDK `fixture-synthetic`@0.0.0; probe
  `chat-pilot`; reviewer fixture maintainer. Hand-authored synthetic coverage retained
  for the generic fixture path; the real OpenCode Chat Completions path is recorded
  under `fixtures/opencode/`.
- **openai/tool-continuation-v1.json** — captured 2026-08-01T11:17:37.169Z from OpenAI
  Responses HTTP with `o3-mini`; SDK `openai`@6.37.0; probe `tool-continuation-v1`;
  reviewer fixture maintainer. Encrypted reasoning payloads and provider identifiers
  were redacted; the committed fixture passed the secret scan. Recapture when the
  Responses wire family or transport-relevant SDK major/minor changes.
- **openrouter/tool-continuation-v1.json** — captured 2026-08-01T11:27:52.049Z from
  OpenRouter AI SDK using `openai/gpt-oss-20b`; SDK `@openrouter/ai-sdk-provider`@2.9.0;
  probe `tool-continuation-v1`; reviewer fixture maintainer. Plaintext model reasoning
  and provider identifiers were redacted; the committed fixture passed the secret scan.
  Recapture when the AI SDK wire family or transport-relevant SDK major/minor changes.

- **google/tool-continuation-v1.json** — captured 2026-08-01T11:59:04.413Z; SDK @ai-sdk/google@3.0.72; model family google; probe `tool-continuation-v1`; reviewer fixture maintainer. Recapture when the wire family or transport-relevant SDK major/minor changes.

- **opencode/tool-continuation-v1.json** — captured 2026-08-01T12:23:52.400Z via OpenCode Go; SDK openai@6.37.0; model `deepseek-v4-flash`; probe `tool-continuation-v1`; reviewer fixture maintainer. Recapture when the wire family or transport-relevant SDK major/minor changes.

- **opencode/tool-continuation-v1-anthropic.json** — captured 2026-08-01T12:18:50.067Z; SDK @ai-sdk/anthropic@3.0.76; model family opencode; probe `tool-continuation-v1`; reviewer fixture maintainer. Recapture when the wire family or transport-relevant SDK major/minor changes.

## Recapture

Run `pnpm provider:record --from-fake chat-completions success --provider fixture --model chat-fixture --out /absolute/private/path`, then `pnpm provider:fixture:prepare <recording>` and review the generated artifact. `--accept` places the reviewed envelope at `scripts/provider-black-box/fixtures/fixture/fake_chat-completions_success.json`, replacing the committed fixture. Live recording additionally requires `--yes`, credentials, an explicit `--probe`, and a real wire capture; it is never part of PR tests.
