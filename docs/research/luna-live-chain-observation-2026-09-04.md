# Luna live-chain observation — 2026-09-04

## Scope

This note records one live Luna parent chain observed from raw capture
`2026-09-03/12-13-16_52786/12-13-49.480Z_3d399_raw.json`. The count below is
for the parent chain only. A separate worker chain was present in the same
session directory and is not included.

## Chronology

1. The parent live Luna chain began at the raw capture named above on
   2026-09-03.
2. At measurement time, the parent chain contained 51 requests: one fresh
   head request followed by 50 chained requests.
3. The raw head and its sanitized artifact were compared for tool metadata,
   body keys, and reasoning settings.

## Observations

- All 51 parent requests used model `gpt-5.6-luna`.
- All parent requests shared the same `previous_response_id` lineage prefix,
  `resp_0f1926eb...`.
- No guard kill, runaway argument, repetitive whitespace padding, or
  difficulty terminating any tool argument occurred in this observation.
- The largest parent raw request body was 93,233 serialized characters; the
  smallest was 1,182, with an average of about 9,695. These measurements are
  request bodies, not output arguments.

## Wire-versus-sanitized comparison

The raw chain head contained 36 `additional_tools` entries. This included one
custom `apply_patch` declaration with a `format` field. The sanitized artifact
reduced those entries to names only, including `apply_patch`. It preserved the
request body keys and the reasoning settings:

```text
{effort: high, context: all_turns}
```

Raw sidecars are outside the repository and do not include payload excerpts.
This note likewise does not reproduce credentials, full prompts, tool
arguments, or raw IDs beyond the truncated lineage prefix above.

## Interpretation and limitations

This is evidence of exposure to a long parent chain without the listed
failures. It argues against a simple, inevitable claim that “a long chain
causes runaway,” but it is not evidence that chaining is harmless. The run is
confounded by an ordinary tool mix and did not deliberately reproduce the M4
repetitive-YAML workload. The observation is therefore not a controlled test
of chain length, workload, or failure thresholds, and the separate worker
chain must remain excluded from the parent-request count.

## Follow-up

- Preserve the distinction between parent and worker chains when counting
  future observations.
- Compare additional live chains with their raw request-body size summaries,
  sanitized metadata, and termination outcomes.
- Run a deliberate, separately identified reproduction of the M4
  repetitive-YAML workload before drawing conclusions about that failure mode.
