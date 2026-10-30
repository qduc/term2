import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanonicalSessionLog, loadCanonicalConversation } from '../src/session/adopted/conversation-log.ts';
import { projectRuntimeSettings } from '../src/session/adopted/settings.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-settings-'));
const workspace = { root, access: 'read_write', target: 'local' } as const;
const model = { provider: 'openai', model: 'a' };
const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const log = CanonicalSessionLog.create({ root, id: 'legacy', metadata: {}, workspace, model, logger });
await log.append([
  {
    type: 'assistant_turn',
    turn: { items: [] },
    state: { previousResponseId: 'old-chain', provider: 'openai', model: 'a' },
  } as any,
  { type: 'settings_changed', key: 'agent.modelSelection', value: { provider: ' openai ', model: ' a ' } },
]);
await log.append([
  {
    type: 'session_settings_initialized',
    version: 1,
    model: { provider: 'openai', model: 'a' },
    reasoningEffort: 'default',
  },
]);
let replay = loadCanonicalConversation('legacy', root, 'live');
assert.equal(replay.previousResponseId, 'old-chain');
assert.equal(replay.model, 'a');
await log.append([{ type: 'settings_changed', key: 'agent.reasoningEffort', value: 'high' }]);
replay = loadCanonicalConversation('legacy', root, 'live');
assert.equal(replay.previousResponseId, 'old-chain');
assert.equal(replay.reasoningEffort, 'high');
assert.equal(
  projectRuntimeSettings(
    log.entries().map((e) => e.fact),
    { selection: model, reasoningEffort: 'default' },
  ).snapshot.reasoningEffort,
  'high',
);
await log.append([{ type: 'settings_changed', key: 'agent.reasoningEffort', value: 'high', sessionMutation: 1 }]);
assert.equal(loadCanonicalConversation('legacy', root, 'live').previousResponseId, null);
await assert.rejects(
  log.append([
    {
      type: 'session_settings_initialized',
      version: 1,
      model: { provider: 'openai', model: 'a' },
      reasoningEffort: 'default',
    },
  ]),
);
await log.dispose();
fs.appendFileSync(
  path.join(root, 'legacy.jsonl'),
  JSON.stringify({
    v: 3,
    seq: 999,
    ts: new Date(0).toISOString(),
    logId: 'legacy',
    eventId: 'corrupt',
    event: { type: 'session_settings_initialized', version: 2, model, reasoningEffort: 'default' },
  }) + '\n',
);
assert.throws(() => CanonicalSessionLog.readOnly(root, 'legacy'));
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS canonical mixed source settings chronology and chain');
