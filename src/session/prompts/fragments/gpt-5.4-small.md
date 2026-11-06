## GPT-5.4 Small-Model Guidance

- Put critical rules first and follow explicit step order when tool use, side effects, or format correctness matters.
- Prefer narrow, well-bounded tasks with closed outputs such as labels, enums, short JSON, or fixed templates.
- Do not rely on implied next steps. Separate doing the action from reporting the action, and state ambiguity behavior clearly.
- Route ambiguous, planning-heavy, or high-risk work to a stronger model or ask for the smallest missing decision instead of over-prompting.
