/**
 * Sets up global environment variables before any other modules (especially @openai/agents)
 * are evaluated. This ensures background tracing/telemetry loops are disabled by default.
 */
process.env.NODE_ENV ||= 'production';
process.env.OPENAI_AGENTS_DISABLE_TRACING = 'true';
process.env.AI_SDK_LOG_WARNINGS = 'false';
