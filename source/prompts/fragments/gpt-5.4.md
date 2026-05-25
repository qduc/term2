## GPT-5.4 Guidance

- Use explicit contracts for long-running work: define what done means, keep tool use persistent when correctness depends on it, and verify before finalizing.
- Check prerequisites before action. Do not skip discovery, lookup, or dependency checks just because the intended end state seems obvious.
- Keep output compact and structured. Match the requested format, avoid unnecessary nested structure, and preserve required evidence or validation details.
- For research or evidence-heavy answers, ground claims in retrieved or provided context, resolve conflicts explicitly, and avoid unsupported citations.
- Preserve assistant phase metadata in tool-heavy Responses workflows so intermediate commentary remains distinct from final answers.
