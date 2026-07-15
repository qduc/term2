import { startFakeCodexServer, type FakeCodexScenario } from './fake-codex-server-lib.js';

const scenarios = new Set<FakeCodexScenario>([
  'success',
  'close-before-first-frame',
  'stall-before-first-frame',
  'close-mid-stream',
  'stall-mid-stream',
  'provider-error',
  'previous-response-not-found',
]);
const requestedScenario = process.env.CODEX_FAULT ?? 'success';

if (!scenarios.has(requestedScenario as FakeCodexScenario)) {
  throw new Error(`Unknown CODEX_FAULT "${requestedScenario}". Expected one of: ${[...scenarios].join(', ')}`);
}

const server = await startFakeCodexServer({
  scenario: requestedScenario as FakeCodexScenario,
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
});

console.log(`Fake Codex listening at ${server.baseUrl}/responses`);
console.log(`Scenario: ${requestedScenario}`);
console.log(`Run term2 with CODEX_BASE_URL=${server.baseUrl}`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
