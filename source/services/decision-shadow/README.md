# Decision shadow pilot

This module compares a Decisions model's predictions with provider failures leaving the run loop. Predictions do not approve actions, select tools, or change retry policy.

## Opt in

Set `agent.decisionModel` to an OpenRouter Decisions model. It is unset by default and shared by the root-agent pilot and approval fast path. For approval, only low/medium-risk, explicit/implied decisions with confidence at least `0.8` authorize directly; every other result falls back to the chore reviewer. The setting is read on every observation; clearing it stops new Decisions requests, while already admitted root-pilot observations may finish.

The root `AgentClient` uses `agent.openrouter.apiKey`, falling back to `OPENROUTER_API_KEY`, and the optional `agent.openrouter.baseUrl`. Agent-override clients used by subagents do not create the pilot. Enabling this incurs additional API charges, including when the main agent uses another provider. Shadow charges are recorded in comparison logs, not added to the foreground cost footer.

## Evidence and comparison labels

Failure evidence contains provider/model/tier, available HTTP status/code/retry-after, a clipped error message and error/cause names. `buildFailureObservation` is shared by runtime and replay. Runtime classifier labels are kept outside prediction evidence. The comparison outcome `run_loop_failed` means that this run loop threw; session-level recovery may subsequently succeed. No final session disposition is collected, so these labels cannot measure whether retrying actually helped. Cancellation is excluded from failure-triage requests.

## Telemetry

- `decision_shadow.started` records admission synchronously with kind, request ID, requested model and prompt version.
- `decision_shadow.failure_triage` records predicted category/retry and separate runtime comparison labels.
- `decision_shadow.failed` retains latency, model identifiers, and provider-reported cost where available. Missing cost/model information is `unknown`.
- `decision_shadow.skipped` records admission skips.

Latency uses a monotonic clock. Costs are USD micros. Invalid billed responses retain reported cost. Started observations without settlement remain incomplete and belong in evaluation denominators. Snapshot failures occur before admission and are separate failures.

The pilot's logs omit input, credentials and raw provider responses. Those input values are still sent to the configured endpoint. Normal application logging has its own policy.

## Replay and promotion

Failure fixtures use `buildFailureObservation`. Expected labels are separate from evidence.

`evaluateReplayFixtures` reuses live prompt builders/parsers and returns totals plus per-case expected/predicted values or errors, confidence, prompt version, requested/resolved model, latency and cost. Errors remain in the denominator. These synthetic fixtures verify plumbing, not model quality. Before promotion, collect representative cases, independently label held-out cases, include skips/incomplete/invalid results, and compare against the current behavior. Agreement with the agent or runtime classifier is not objective correctness.

## Containment and limits

One pilot admits up to four concurrent terminal-failure observations. Capacity is checked before copying evidence. A fifth observation is skipped. The existing shared transport aborts requests after 10 seconds; optional request or logger failures do not replace foreground results.

The run loop never awaits a Decisions response. Evidence cloning is synchronous and can add foreground work. There is no payload-size cap or representative overhead measurement yet; long inputs may exceed the model's context and must count as failed observations. This pilot does not truncate failure evidence to conceal that limitation.

There is no shutdown drain. One-shot processes can exit before comparisons finish; start records expose that missing data but do not recover results. Keep this pilot observational until representative quality, latency, cost and completion measurements justify a specific task's next step.
