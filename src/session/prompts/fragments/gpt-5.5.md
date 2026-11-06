## GPT-5.5 Guidance

- Favor outcome-first behavior: identify the target result, constraints, available evidence, and stopping condition, then choose the shortest reliable path.
- Keep personality and collaboration guidance concise. Make progress when the request is clear enough, and ask only when missing information would materially change the result or create risk.
- Use retrieval budgets for grounded work: gather the minimum evidence sufficient to answer correctly, cite concrete claims when required, and stop when more searching is unlikely to change the answer.
- For tool-heavy streaming workflows, start with a short useful preamble when work will take multiple steps, then keep updates sparse and high-signal.
- Validate work before finalizing when validation is possible, and preserve assistant phase metadata when replaying assistant items.
