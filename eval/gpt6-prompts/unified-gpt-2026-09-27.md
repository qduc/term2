# Unified GPT main-agent prompt: paired next-action probe

Control: model-specific GPT main-agent bases at `92d9a7aa`. Candidate: one
`gpt.md` base for GPT-5.x and GPT-6 main agents, with GPT-6-only guidance
folded into that base. Both cells used `codex` over HTTP, low reasoning effort,
the same twelve synthetic cases in `source/scripts/eval-gpt6-prompts.ts`, and
the same inert tool definitions. One full run per model per cell; tools were
advertised but never executed. Worker and orchestrator prompts were unchanged.

| Model | Control next-action pass | Candidate next-action pass |
| --- | ---: | ---: |
| gpt-6-astra | 12/12 | 12/12 |
| gpt-6-sol | 12/12 | 12/12 |
| gpt-6-luna | 12/12 | 11/12 |
| gpt-5.6-luna | 12/12 | 12/12 |

All five main-agent edit-intent cases per model selected `run_code` in both
cells. The explicit read-only case selected no tool in both cells. The sole
candidate miss was `required-worker-check`: GPT-6 Luna answered instead of
running the explicitly requested post-edit `pnpm lint`. This case uses the
unchanged worker instructions, not the GPT main-agent base. Two further
candidate repetitions split fail/pass, showing that this synthetic next-action
case is variable. It is not evidence that the changed main-agent prompt caused
a worker regression.

Conclusion: no demonstrated improvement; no observed main-agent next-action
regression in this sample. The simplification reduces GPT main-agent base files
from five to one and removes the GPT-6-only fragment. These probes cannot
measure end-to-end completion, tool execution, editing validity, or performance
of untested GPT-5 variants (including GPT-5.4 and Codex). Do not use these
one-shot totals as a general solve-rate claim. Deterministic routing tests and
full unit/integration suites validate the code and prompt assembly separately.
