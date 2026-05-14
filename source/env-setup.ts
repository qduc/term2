/**
 * Sets up global environment variables before any other modules (especially @openai/agents)
 * are evaluated. This ensures background tracing/telemetry loops are disabled by default.
 */
process.env.OPENAI_AGENTS_DISABLE_TRACING = 'true';
