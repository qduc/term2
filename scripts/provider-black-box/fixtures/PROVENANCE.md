# Real-traffic fixture provenance

These are sanitized, reviewed wire envelopes. Raw recordings are never committed.
Replay fixtures validate captured provider behavior; they do not replace live canaries
for changes after capture.

> **Status: machinery pilot only.** The committed fixtures are synthetic — recorded
> from the fake provider or hand-authored to match the app's request serialization.
> None has been captured from real provider traffic. The Phase 4 pilot acceptance (a
> live capture whose replay confirms or corrects the hand-written `framesFor()` wire
> shapes) is **not yet met**; these fixtures validate the record → sanitize → replay
> machinery end-to-end and nothing more. Recapture the fake-derived fixture with the
> command below; the reviewed result replaces it.

- **fixture/fake_chat-completions_success.json** — recorded from the fake provider via
  `provider:record --from-fake chat-completions success`; SDK `fixture-fake-provider`@1.0.0
  (never a real SDK — the drift test skips it); probe `fake:chat-completions:success`;
  reviewer fixture maintainer. Recapture when the record/replay machinery changes, not on
  SDK bumps.
- **fixture/chat-pilot.json** — synthetic pilot fixture exercising the Chat Completions
  registry path (`provider-contract.test.ts`); SDK `fixture-synthetic`@0.0.0; probe
  `chat-pilot`; reviewer fixture maintainer. Hand-authored; replace with a real recording
  when the live pipeline is exercised (it will then land under
  `fixtures/fixture-chat-completions/` and the test path must move with it).

## Recapture

Run `pnpm provider:record --from-fake chat-completions success --provider fixture --model chat-fixture --out /absolute/private/path`, then `pnpm provider:fixture:prepare <recording>` and review the generated artifact. `--accept` places the reviewed envelope at `scripts/provider-black-box/fixtures/fixture/fake_chat-completions_success.json`, replacing the committed fixture. Live recording additionally requires `--yes`, credentials, an explicit `--probe`, and a real wire capture; it is never part of PR tests.
