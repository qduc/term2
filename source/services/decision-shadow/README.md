# Decision shadow pilot

This module compares a Decisions model's predictions with two root-agent observations: tool selection and provider failures leaving the run loop. Predictions do not select tools, approve actions, or change retry policy.

## Opt in

Set `agent.decisionModel` to an OpenRouter Decisions model. It is unset by default and shared by the root-agent pilot and approval comparisons. It is read on every observation; clearing it stops new requests, while already admitted requests may finish.

The root `AgentClient` uses `agent.openrouter.apiKey`, falling back to `OPENROUTER_API_KEY`, and the optional `agent.openrouter.baseUrl`. Agent-override clients used by subagents do not create the pilot. Enabling this incurs additional API charges, including when the main agent uses another provider. Shadow charges are recorded in comparison logs, not added to the foreground cost footer.

## Evidence and comparison labels

Each admitted tool-selection request sends the final provider request input to OpenRouter: conversation content, tool outputs and file contents present in that input. Chained requests can contain only a delta. The catalog includes directly callable tools and ready, collision-filtered built-in and MCP capabilities exposed through `run_code`, with descriptions, schemas and approval metadata. MCP descriptions remain marked as untrusted server content. Each provider attempt is a separate observation, including retries.

Failure evidence contains provider/model/tier, available HTTP status/code/retry-after, a clipped error message and error/cause names. `buildFailureObservation` is shared by runtime and replay. Runtime classifier labels are kept outside prediction evidence. The comparison outcome `run_loop_failed` means that this run loop threw; session-level recovery may subsequently succeed. No final session disposition is collected, so these labels cannot measure whether retrying actually helped. Cancellation is excluded from failure-triage requests.

## Telemetry

- `decision_shadow.started` records admission synchronously with kind, request ID, requested model and prompt version.
- `decision_shadow.tool_selection` joins a valid or invalid prediction to its observed selection/outcome. Logical nested calls are available because factory wrapping preserves the run-code execution metadata.
- `decision_shadow.failure_triage` records predicted category/retry and separate runtime comparison labels.
- `decision_shadow.failed` retains latency, model identifiers, and provider-reported cost where available. Missing cost/model information is `unknown`.
- `decision_shadow.skipped` records admission skips.

Latency uses a monotonic clock. Costs are USD micros. Invalid billed responses retain reported cost. A failed tool prediction can have both a failure event and a later comparison event: join by kind/request ID rather than summing both. Started observations without settlement remain incomplete and belong in evaluation denominators. Snapshot failures occur before admission and are separate failures.

The pilot's logs omit input, schemas, credentials and raw provider responses. Those input/schema values are still sent to the configured endpoint. Normal application logging has its own policy.

## Replay and promotion

`buildToolSelectionReplayFixture` snapshots an observed tool graph through the production catalog builder; use factory-built tools for root-session fixtures. The factory contract test exercises that boundary and nested execution. The bundled direct-only read-file example uses the real tool definition; it is deliberately synthetic. Failure fixtures use `buildFailureObservation`. Expected labels are separate from evidence.

`evaluateReplayFixtures` reuses live prompt builders/parsers and returns totals plus per-case expected/predicted values or errors, confidence, prompt version, requested/resolved model, latency and cost. Errors remain in the denominator. These synthetic fixtures verify plumbing, not model quality. Before promotion, collect representative cases, independently label held-out cases, include skips/incomplete/invalid results, and compare against the current behavior. Agreement with the agent or runtime classifier is not objective correctness.

## Containment and limits

One pilot admits up to four concurrent requests and retains up to four tool predictions awaiting outcomes. Capacity is checked before copying evidence. A fifth observation is skipped. The existing shared transport aborts requests after 10 seconds; optional request or logger failures do not replace foreground results.

The run loop never awaits a Decisions response. Evidence cloning and schema conversion are synchronous and can add foreground work. There is no payload-size cap or representative overhead measurement yet; long inputs may exceed the model's context and must count as failed observations. This pilot does not truncate conversation evidence to conceal that limitation.

There is no shutdown drain. One-shot processes can exit before comparisons finish; start records expose that missing data but do not recover results. Tool selection predicts a primary capability, not a complete multi-tool plan. Keep this pilot observational until representative quality, latency, cost and completion measurements justify a specific task's next step.
