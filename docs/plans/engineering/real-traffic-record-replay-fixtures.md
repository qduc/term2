# Real-Traffic Record-and-Replay Fixtures

**Status:** approved-with-fixes (adversarial review); refined per review; OpenAI Responses HTTP, OpenRouter AI SDK, Google GenerateContent, OpenCode Chat Completions, and OpenCode Go Anthropic pilots complete. The generic `chat-pilot.json` remains synthetic; direct Anthropic capture is still credit-gated.
**Last updated:** 2026-08-01

## Resume here

This plan builds a record → sanitize → replay pipeline that grounds our fake provider
fixtures in real provider wire shapes while keeping normal tests fully offline. Before
touching `scripts/provider-black-box/`, the traffic logger, or the provider transport
layers, read the **Verified facts** and **Design decisions** sections below. They
record decisions already taken and premises already disproven:

- The existing provider-traffic artifacts **cannot** serve as replay sources — sent
  bodies are truncated to 100 chars (`TRAFFIC_TEXT_LIMIT` in
  `source/services/logging/provider-traffic.ts`), tool definitions are reduced to
  names, SSE frames are reassembled into summaries, and WebSocket responses are
  collapsed into a single delta payload (`summarizeWebsocketResponse`). This is
  verified in code, not assumed.
- The replay suite now has both `fake-provider-http-server.ts` and
  `fake-provider-websocket-server.ts`. WS replay remains synthetic because no live WS
  recording has been captured; the ResponsesWS/Codex live adapter is still the
  highest-cost follow-up.
- Frame granularity is fixed: the envelope stores **logical protocol frames** (parsed
  SSE `event:`/`data:` pairs, WS messages, JSON bodies), never TCP chunk boundaries.
  TCP chunking is non-deterministic and unreplayable.
- The recorder is **self-validated offline** by a record-from-fake loop before any live
  run; raw recordings stay **permanently** outside the repository (not "initially").
- Phases 3–4 are **gated on a pilot**: the practical first live pilot was OpenAI
  Responses HTTP, followed by OpenRouter's built-in AI SDK path and Google
  GenerateContent. The recorder now provisions the existing Anthropic/Google
  compatible definitions for live capture;
  Google credentials are read from `GEMINI_API_KEY`, and Anthropic-format capture can
  target OpenCode Go through `https://opencode.ai/zen/go/v1` or the `opencode` provider
  with Qwen/Minimax models. Direct Anthropic capture remains credit-gated. The OpenCode
  provider now also supplies a live OpenAI Chat Completions capture path. The Responses pilot
  demonstrated a real shape discrepancy: the minimal hand-written frames omitted
  reasoning/item lifecycle and function-argument events.

## Summary

- Add a versioned fixture envelope capturing sanitized request/response wire frames per
  provider family, transport, and protocol version.
- Add an explicit, opt-in live recorder at the transport boundary that captures raw
  frames (not summaries) from a scripted multi-turn probe, writing outside the repo.
- Add a prepare step that sanitizes, secret-scans, and human-approves fixtures before
  they are committed.
- Extend the fake HTTP server to replay envelopes and add a new fake WebSocket server
  for the Responses-WS paths; replay success-path frames exactly while keeping
  synthetic frames for error-path mutations.
- Wire replay fixtures into the provider black-box suite, pilot-gated.
- Document provenance and add an automated SDK-version drift check so stale fixtures
  fail loudly instead of passing silently.

## Verified facts about the current code (grounding)

- `scripts/provider-black-box/fake-provider-http-server.ts` — `framesFor()` emits
  hand-written frames (`resp_fake`, `msg_fake`, `chatcmpl_fake`) for scenarios
  `success | error | early-close | incomplete | tool-fragments | reasoning`. These are
  not derived from real traffic; validating them against reality is the core gap.
- `scripts/provider-black-box/provider-contract.test.ts` — five cases: OpenAI Responses
  HTTP, Chat Completions, Anthropic, Google, OpenRouter (via AI SDK). Asserts semantic
  shape (`events`, `server.requests` bodies) against the fake server.
- `source/services/logging/provider-traffic.ts` — sent body truncation, tool-def →
  name reduction, SSE reassembly, WS collapse. Confirmed replay-unusable.
- `source/providers/fetch/logging-middleware.ts` — wraps fetch with access to the raw
  `Response` (cloned); the natural HTTP/SSE capture seam. Reuses `sanitizeHeaders`
  (`source/utils/header-sanitizer.ts`) and `installationVersion`.
- Codex and OpenAI Responses WS both go through the OpenAI SDK `ResponsesWS`; traffic
  capture today sees only the assembled model response with `transport: 'websocket'`
  (`source/providers/codex-responses-model.ts`, `source/providers/codex.provider.ts`).
  Frame-level WS capture is net-new.
- OpenRouter in the suite runs through `source/providers/ai-sdk-openrouter.provider.ts`
  — the AI SDK is a third capture seam, distinct from the fetch middleware.
- Codex has WS→HTTP fallback logic (`isRetryableTransportError().transportFallback`)
  that replay fixtures cannot exercise; it stays synthetic coverage.
- `package.json` exposes `provider:record` and `provider:fixture:*` scripts; the
  recorder, prepare flow, replay servers, and CI gates are implemented.

## Design decisions (fixed by this plan)

- **D1 — Frame granularity.** The envelope stores logical protocol frames: parsed SSE
  events (event name + `data:` payload), WS messages (direction + payload), and JSON
  bodies. Never raw TCP chunks.
- **D2 — WS replay is bidirectional.** The fake WS server validates the app's outbound
  message *sequence* against the recording, not a single request/response. The
  envelope's WS frame list is one ordered send/receive stream per socket session
  (including control messages the SDK sends, e.g. `session.created` acks).
- **D3 — The probe is a scripted multi-turn scenario that triggers a real tool call.**
  A single harmless prompt captures none of the interesting frames (call IDs, argument
  deltas, tool-name/args ordering, continuation). The probe drives: user message →
  tool-call response → tool result + follow-up → final answer. The envelope supports
  multi-turn recordings with inter-turn references (`call_id` in a response matching
  the follow-up request).
- **D4 — Recorder self-validation.** The pipeline must support recording from the
  existing fake servers, then replaying the recording through the fake servers and
  diffing. This makes the entire record→sanitize→replay machinery testable in CI with
  zero credentials and catches recorder bugs before the rare live runs.
- **D5 — Raw recordings stay out of the repo permanently.** Only sanitized,
  human-reviewed envelopes are committed. No "initially".
- **D6 — Capture seams are enumerated, not implied.** Three adapter families:
  fetch middleware (OpenAI HTTP, Chat Completions, Anthropic, Google), `ResponsesWS`
  events (OpenAI/Codex WS), AI SDK transport (OpenRouter).
- **D7 — Outbound request comparison is SDK-churn tolerant.** The semantic comparator
  canonicalizes both sides (placeholder mapping, ordering) and applies an allow-list of
  SDK-churn fields (new headers, `stream_options`, SDK-added body keys) so an SDK bump
  does not break the fixture suite.
- **D8 — Error-path mutations stay synthetic.** Early-close, incomplete-stream, and
  fragmented-tool-call scenarios are deliberately synthetic and easier to reason about
  than mutations of noisy real frames. Replay fixtures validate success-path
  serialization/ordering; synthetic mutations remain for error paths.
- **D9 — Response payloads are treated as sensitive.** Providers can echo request
  content (outputs, error bodies). The sanitizer handles response `data:` payloads,
  not just request headers/bodies.
- **D10 — Automated drift signal.** A CI test compares the current installed SDK
  version against the envelope's recorded version and fails with recapture
  instructions when the transport-relevant version diverges.
- **D11 — Pilot gating.** Phases 3–4 roll out per provider, gated on the pilot
  proving the loop end-to-end. The first completed pilot is OpenAI Responses HTTP;
  OpenCode Chat Completions and OpenCode Go Anthropic pilots are now also complete.
  The standalone generic Chat Completions fixture remains synthetic by choice.

## Phase 0 — Fixture envelope contract

New file: `scripts/provider-black-box/fixture-envelope.ts` (types + validation),
fixtures committed under `scripts/provider-black-box/fixtures/<provider>/`.

Envelope v1 (`schemaVersion: 1`):

```ts
type FixtureEnvelopeV1 = {
  schemaVersion: 1;
  kind: 'real-traffic-recording';
  provider: string;        // registry provider id
  wireFamily: string;      // 'openai-responses' | 'openai-chat' | 'anthropic' | 'google' | 'ai-sdk'
  transport: 'http-sse' | 'http-json' | 'websocket';
  capture: {
    sdkPackage: string;    // e.g. 'openai'
    apiSdkVersion: string; // exact version used to record
    model: string;
    modelFamily: string;
    capturedAt: string;    // ISO date
    recorderVersion: string;
    probeScenario: string; // id of the scripted probe
  };
  turns: Array<{            // one unit per probe turn (HTTP) or per socket session (WS)
    frames: Array<
      | { seq: number; kind: 'http-request'; method: string; urlPath: string; headers: Record<string, string>; body: unknown }
      | { seq: number; kind: 'http-response-head'; status: number; headers: Record<string, string> }
      | { seq: number; kind: 'sse-event'; event?: string; data: string }
      | { seq: number; kind: 'json-body'; body: unknown }
      | { seq: number; kind: 'ws-message'; direction: 'send' | 'receive'; data: unknown }
    >;
  }>;
  placeholders: Record<string, string>; // dynamic → stable id mapping (see below)
};
```

Placeholder rules:

- Dynamic IDs, timestamps, tokens, and URLs are replaced with stable placeholders
  (`resp_abc123` → `resp_<1>`, `call_xyz` → `call_<2>`) via a single per-fixture map.
- The map is applied consistently across all frames **and** turns, so cross-frame and
  inter-turn references (`response_id`, `call_id`, continuation IDs) are preserved.
- Validation rejects: placeholder collisions, references to unmapped entities, and
  envelope-shape violations. Unit-test the validator.

Acceptance: validator tests cover all five frame kinds, multi-turn references, and
placeholder collision rejection.

## Phase 1 — Explicit live recorder

New CLI: `pnpm provider:record --provider <id> --model <model> [--probe <scenario>] [--out <dir>]`.

- **Disabled by default.** Refuses to run without explicit `--yes` opt-in, without the
  provider's credentials env vars, and without an explicit probe scenario.
- **Writes outside the repo permanently** to `~/.term2/provider-recordings/`
  (overridable via `$TERM2_RECORDING_DIR`). Never writes to cwd. Never records
  ordinary conversations — only the scripted probe.
- **Probe:** deterministic scripted scenario per D3 (multi-turn with a real tool call).
  The probe schema is a fixture itself (`scripts/provider-black-box/probe-scenarios.ts`),
  shared with the replay tests so probe arguments are not user-sensitive.
- **Capture adapters (D6):**
  1. *fetch middleware* (`source/providers/fetch/`): a recorder middleware placed
     outside the logging middleware; tees the raw response body without buffering it,
     extracts SSE events/JSON, records sanitized request.
  2. *`ResponsesWS` events* (`source/providers/`): wraps the socket's `onmessage` and
     the SDK's outbound send path; records the ordered bidirectional message stream.
  3. *AI SDK transport* (`source/providers/ai-sdk-*.ts`): hooks the AI SDK fetch/transport
     option for OpenRouter.
- **Self-validation (D4):** `pnpm provider:record --from-fake <protocol> <scenario>`
  records from the existing fake server; the result must replay cleanly through the
  replay layer and diff to identity. This runs in CI with no credentials.
- Recorder records `capture.apiSdkVersion` from the installed SDK package version.

Acceptance: self-validation loop green in CI; recorder refuses to run without opt-in;
recorded artifact contains individual frames, not summaries.

## Phase 2 — Sanitize and approve

New CLI: `pnpm provider:fixture:prepare <recording> [--accept]`.

- **Redaction:** remove `authorization`, `cookie`, `x-api-key`, `api-key` headers and
  values; replace org/project/account identifiers; strip bearer tokens. Reuse and
  extend `source/utils/header-sanitizer.ts`.
- **Dynamic value canonicalization:** apply the per-fixture placeholder map per Phase 0.
- **Content handling (D9):** remove or replace user-sensitive prompt/tool data in both
  request **and response** payloads (echo risk); preserve protocol fields, nesting,
  event names, ordering, and argument fragments.
- **Secret scanner:** reject fixtures containing likely secrets. Patterns include
  `sk-…` values, bearer tokens, PEM blocks, and high-entropy strings. The scanner is
  unit-tested with known-bad cases (repo convention: prove red without the scan).
- **Human review gate:** `prepare` emits a review artifact (sanitized envelope +
  placeholder map + redaction report). `--accept` copies the envelope into
  `scripts/provider-black-box/fixtures/<provider>/` and appends a line to
  `fixtures/PROVENANCE.md` (capture date, SDK version, probe id, reviewer).
  Fixtures are committed only after this step; the raw recording never enters the repo.
- **CI secret scan:** a cheap test scans the committed `fixtures/` tree for the same
  secret patterns, so a bad fixture cannot be committed later.

Acceptance: known-secret fixture rejected by both scanner and CI test; placeholder map
preserves cross-frame references; PROVENANCE.md entry required for each fixture.

## Phase 3 — Replay layer (complete)

- **`fake-provider-http-server.ts`:** loads fixture envelopes, replays frames in
  order, and compares app requests semantically using placeholders and the SDK-churn
  allow-list (D7).
- **`fake-provider-websocket-server.ts`:** serves a `WebSocket` endpoint that
  validates outbound message order and replays recorded receives using the envelope's
  ordered stream (D2). It has synthetic test coverage; no live WS envelope exists yet.
- **Deterministic mutations (D8):** keep the existing synthetic scenarios
  (`error | early-close | incomplete | tool-fragments | reasoning`) as hand-written
  frames; add envelope-driven truncations only where they add coverage (e.g. drop the
  terminal `response.completed`/`message_stop` frame from a real recording).
- **Self-validation (D4):** replay of a from-fake recording must diff to identity;
  this is the offline oracle for the whole pipeline.

Acceptance: from-fake record→replay→diff green; outbound comparison flags an injected
request-shape mutation; WS fake validates outbound sequence and rejects a reordered
or missing message.

## Phase 4 — Connect to the suite (pilot-gated)

- **Completed pilots:** OpenAI Responses HTTP (`o3-mini`), OpenRouter AI SDK
  (`openai/gpt-oss-20b`), Google GenerateContent (`gemini-2.5-flash`), OpenCode Chat
  Completions via OpenCode Go (`deepseek-v4-flash`), and OpenCode Go Anthropic Messages
  (`minimax-m3`) are accepted under `fixtures/openai/`, `fixtures/openrouter/`,
  `fixtures/google/`, and `fixtures/opencode/`. They replay two-turn tool
  continuations through registry paths with semantic tool/text/completion assertions.
  The Responses red-proof found that `framesFor('responses', 'success')` is only a
  minimal synthetic shape; the real fixtures additionally retain provider reasoning/
  item lifecycle, function-argument, content-part, thought, and terminal event ordering
  where applicable.
- **Remaining provider work:**
  1. Generic Chat Completions: decide whether to replace the synthetic
     `chat-pilot.json`; the live OpenCode Chat Completions path is already captured and
     wired under `fixtures/opencode/`.
  2. Direct Anthropic API capture remains optional and credit-gated; the Anthropic
     wire family is covered by the accepted OpenCode Go fixture.
  3. OpenAI Responses WebSocket + Codex WebSocket: implement the live `ResponsesWS`
     capture adapter and capture a bidirectional continuation; current WS coverage
     remains synthetic.
- OpenRouter's accepted fixture is large because the model emitted extensive
  reasoning deltas. Decide whether its maintenance value justifies retaining it or
  whether to replace it with a shorter approved model capture; do not remove it
  without preserving equivalent semantic coverage.
- Assertions stay semantic (roles, ordering, IDs, authoritative completion/error
  events, reasoning), but the raw frame fixtures are retained so event ordering and
  native field names remain testable without full-JSON snapshot coupling.

Acceptance: each provider's suite case passes against a recorded fixture; the
hand-written frames for that provider are either validated or replaced.

## Remaining work and maintenance

- Keep the accepted OpenAI/OpenRouter/Google/OpenCode Go fixtures aligned with SDK major/minor drift;
  recapture when event names, field names, or transport-relevant versions change.
- Run occasional live canaries separately from ordinary CI; replay cannot detect
  provider-side changes after capture.
- Complete the provider items listed in Phase 4, then replace this section's status
  with the next provider-specific resume point.

## Phase 5 — Maintenance and drift detection

- **Provenance manifest:** `fixtures/PROVENANCE.md` documents, per fixture: capture
  date, SDK package+version, model family, probe id, recapture trigger, and reviewer.
- **Automated drift signal (D10):** a CI test reads each envelope's
  `capture.apiSdkVersion` and fails loudly with recapture instructions when the
  installed SDK's transport-relevant major/minor diverges.
- **Recapture procedure:** run the recorder, prepare, review, accept — documented in
  the manifest; a fixture is stale when the wire family changes (new event names,
  changed field names) or the recorded SDK version no longer matches.
- **Fixture diff review:** envelopes are JSON; PR diffs show frame-level changes.
  Review checklist: placeholder map stable, no new secrets, frame order intact,
  PROVENANCE.md updated.
- **Live canaries:** occasional live probes remain necessary for drift detection but
  are separate from PR and ordinary local tests (e.g. a manual or scheduled run of
  `provider:record` with a canary script). Replay tests do not detect provider
  changes after capture — state this in the manifest.

## Open decisions — resolutions

1. **One harmless live probe per provider family:** accepted. Probes are the scripted
   multi-turn tool-call scenarios (D3), recorded only with explicit opt-in and live
   credentials, and only after the offline self-validation loop is green.
2. **Committed vs. private fixtures:** sanitized envelopes are committed (the suite
   already commits sanitized artifacts); raw recordings stay out of the repo
   permanently (D5), with a CI secret scan over the committed tree.
3. **Pilot:** OpenAI Responses HTTP first because the live recorder's built-in
   registry path supports it. The accepted fixtures now validate OpenAI Responses,
   OpenRouter AI SDK, Google GenerateContent, OpenCode Chat Completions, and
   OpenCode Go Anthropic continuations. Generic Chat Completions remains synthetic only for the standalone
   fixture provider; Codex WS follows as a single net-new work item, not an extension.

## Verification plan

- **Offline oracle:** record-from-fake → prepare → replay → diff must be green in CI
  with no credentials (D4). This validates recorder, sanitizer, envelope, and replay
  layers together.
- **Pilot acceptance:** OpenAI Responses HTTP, OpenRouter AI SDK, Google
  GenerateContent, OpenCode Chat Completions, and OpenCode Go Anthropic fixtures are wired into the suite
  through registry paths with semantic tool/text/completion assertions passing. The
  pre-capture `framesFor('responses')`
  red-proof showed its minimal synthetic event list did not match the real capture;
  real fixtures are retained for success-path coverage and synthetic frames remain
  for deterministic mutations.
- **Unit tests:** envelope validator (all five frame kinds, collisions), secret
  scanner (known-bad cases), placeholder mapping (cross-frame + inter-turn identity),
  SDK-churn allow-list, WS outbound-sequence comparator.
- **Regression discipline:** for any bug the replay surfaces, add the regression test
  first (red), then fix (green) — repo convention.
- **Gate:** run `pnpm test:provider-black-box`, the focused provider unit tests, and
  `pnpm typecheck` per provider wiring; full suite before handoff.

## Non-goals

- No changes to the ordinary conversation traffic-log format (it stays a diagnostic
  artifact; it is not a replay source).
- No live tests in PR or ordinary local runs; live probes are manual/scheduled only.
- No migration of legacy daily traffic files.
- No capture of user conversations, ever.
