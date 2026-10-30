/**
 * engine/ — the turn loop and nothing else.
 *
 * Takes history, tools and a model and runs one turn, emitting one event
 * stream. When a tool needs approval it suspends and returns a serializable
 * continuation instead of calling up into a UI. Owns compaction. A subagent is
 * a nested engine run whose events are wrapped in `subagent`.
 * Depends on: model, tools, config.
 */
export {};
//# sourceMappingURL=index.js.map