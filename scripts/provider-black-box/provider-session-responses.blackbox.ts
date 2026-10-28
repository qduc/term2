import { registerResponsesContinuityScenarios } from './provider-session-responses-scenarios.js';

registerResponsesContinuityScenarios();

// Aggregate ledger for the continuity, tools and failures entry files.
/** Typed lifecycle ledger consumed by the Gate C matrix-accounting test. */
export { RESPONSES_CAPABILITY_EXECUTIONS as executedCapabilityScenarioIds } from './provider-session-capability-manifest.js';
