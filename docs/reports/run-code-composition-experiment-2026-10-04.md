# Local run_code composition experiment

## Question and method

Does separating payload bytes from JavaScript source avoid the mechanical
composition failures observed with embedded template literals?

`run-code-composition-experiment.test.ts` sends five identical payloads through
three strategies using `createRunCodeToolDefinition`: naive template embedding,
an escaped literal produced by `JSON.stringify`, and `inputs.payload`. The real
public host performs parsing, sandbox execution, parameter validation and nested
dispatch. Only the nested capture tool is a fixture; it records exact bytes and
has no filesystem or external effects. Parse failures must dispatch nothing.

## Observed results

| Payload | Naive template | Escaped literal | inputs |
| --- | --- | --- | --- |
| Plain text | Exact | Exact | Exact |
| Backticks | Parse failure, no dispatch | Exact | Exact |
| Literal interpolation | Changed to `2` | Exact | Exact |
| Quotes and newline | Exact | Exact | Exact |
| JSX with template interpolation | Parse failure, no dispatch | Exact | Exact |

All 15 assertions passed on 2026-10-04. The naive strategy preserved 2/5
payloads, failed parsing for 2/5, and silently changed 1/5. Both controls
preserved 5/5. An initial fixture run omitted the outer invocation identity
required to attach structured execution evidence; after binding that identity,
the experiment passed without production changes.

Reproduction command (executed):

```bash
pnpm exec cross-env NODE_ENV=test vitest run source/tools/system/run-code/run-code-composition-experiment.test.ts
```

## Interpretation and limits

This is deterministic local host-boundary evidence, not a model solve-rate A/B,
an estimate of failure frequency, or evidence about model compliance. No paid
provider calls were made. The escaped-literal control shows that `inputs` is not
the only correct strategy: correct serialization also works. `inputs` removes
the need to compose payload syntax into the program, including the silent
interpolation hazard. The existing editing guidance already recommends it for
multiline text, quotes, backticks and interpolation. These results do not
justify a compiler or a new execution guard.
