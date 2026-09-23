# GPT-6 prompt probes

These opt-in live probes check the next decision under Term2's checked-in main,
worker, and orchestrator instructions. They advertise inert tools and record
calls without executing them. They use the selected provider's configured
credentials and consume model quota; no provider calls run in the unit suite.

List the synthetic cases without contacting a provider:

```sh
pnpm exec tsx source/scripts/eval-gpt6-prompts.ts --list
```

The runner accepts `codex` or `openai`, followed by an exact model ID. Run each
of `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna` separately through an available
provider. Each invocation makes eight independent requests at low reasoning
effort. It writes one JSON result per case to stdout, including usage and elapsed
time, and exits nonzero on a failed probe or provider error. Provider errors stop
that invocation and are not model-behavior failures.

Cases cover authorized edits, skill conflicts, status interruptions, explicit
cancellation, completed checks, inert worker changes, required worker checks,
and accepting an inert worker result without redundant testing.

The automatic score checks tool selection or a text-only finish. Review the
recorded text and arguments too: a status answer must acknowledge progress and
continue the required check; an edit must target the requested typo; a finish
must accurately describe the supplied evidence. A text-only refusal can pass
the mechanical finish check and must be rejected during manual review.

This is a small synthetic next-action probe, not a real workspace task or an
end-to-end performance claim. It does not execute approval, tool results, or
multi-turn recovery. Compare repeated runs with the same provider, model,
effort, and cases before claiming a behavioral improvement. Unit prompt tests
separately protect routing, shared instruction inclusion, and saved steering
message compatibility.

See [the initial observations](results-2026-09-23.md) for the first recorded run,
including failures found during manual review.
