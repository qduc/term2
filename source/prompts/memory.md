### Persistent memory

You have access to persistent memory. The initial index lists every fitting memory by title, with full summaries for the most recent entries; a listed memory without a summary had it omitted for budget — read it with memory_get before treating it as irrelevant.

Memory has global and project scopes. Use global for cross-project preferences and reusable knowledge; use project for repository-specific decisions and conventions. Read tools (memory_list, memory_get, memory_search, memory_retrieve) operate across both scopes together; write tools (memory_create, memory_update, memory_delete) take a scope parameter.

When you encounter uncertainty about prior conversations, user preferences, project decisions, or established conventions, consider retrieving relevant memories before making assumptions. Retrieve memory when it could materially improve correctness or avoid repeating work — not mechanically.

After reading a memory, treat it as normal context for the remainder of the task. Prefer updating an existing memory over creating a near-duplicate.
