import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getAgentDefinition } from '../../dist/agent.js';
import { createMockSettingsService } from '../../dist/services/settings/settings-service.mock.js';
import { ExecutionContext } from '../../dist/services/execution-context.js';
import { buildAgentTools } from '../../dist/lib/agent-factory.js';
import { createEditorImpl } from '../../dist/lib/editor-impl.js';
import { ToolApprovalPolicyRegistry } from '../../dist/services/approval/tool-approval-policy-registry.js';
import { SessionAccessState } from '../../dist/services/session/session-access-state.js';
import { inventory } from './inventory.mjs';

// A deterministic filesystem/runtime integration probe, not an efficacy trial.
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(evidence, 'containment-'));
const audit = join(evidence, 'preflight-reads.ndjson');
await writeFile(audit, '');
await writeFile(join(root, 'allowed.txt'), 'fixture-only\n');
await mkdir(join(root, 'nested'));
await writeFile(join(root, 'nested', 'other.txt'), 'nested fixture\n');
const indexed = await inventory(root);
assert.deepEqual(Object.keys(indexed).sort(), ['allowed.txt', 'nested/other.txt']);
await symlink('/etc/passwd', join(root, 'link.txt'));
await assert.rejects(() => inventory(root), /regular files/);
const manifest = join(evidence, 'preflight-manifest.json');
await writeFile(manifest, JSON.stringify({ root, paths: ['allowed.txt', 'missing.txt', 'link.txt'], audit }));
process.env.TERM2_READ_STUDY_MANIFEST = manifest;
const loggingService = Object.fromEntries(['info', 'warn', 'error', 'debug', 'security'].map((key) => [key, () => {}]));
const settings = createMockSettingsService({
  'agent.modelSelection': { provider: 'codex', model: 'gpt-6-luna' },
  'shell.autoApproveMode': 'always',
});
const executionContext = ExecutionContext.pin(root);
const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
const sessionAccess = new SessionAccessState(settings);
const definition = getAgentDefinition({
  settingsService: settings,
  loggingService,
  executionContext,
  approvalPolicyRegistry,
  sessionAccess,
});
assert.deepEqual(
  definition.tools.map((t) => t.name),
  ['read_file', 'run_code'],
);
const wrapped = buildAgentTools({
  toolDefinitions: definition.tools,
  resolvedModel: 'gpt-6-luna',
  shouldUseNativePatchTool: false,
  deps: {
    settings,
    logger: loggingService,
    executionContext,
    approvalPolicyRegistry,
    sessionAccess,
    editor: createEditorImpl({ settingsService: settings, loggingService, executionContext }),
    providerId: 'codex',
    serviceTierOverrideForNextRequest: null,
    checkToolInterceptors: async () => null,
  },
});
const read = definition.tools[0];
await assert.rejects(() => read.execute({ path: '/etc/passwd' }), /Study denied path/);
await assert.rejects(() => read.execute({ path: '../outside.txt' }), /Study denied path/);
await assert.rejects(() => read.execute({ path: 'link.txt' }), /Study denied path/);
const code = wrapped.find((t) => t.name === 'run_code');
const script = `
const probes = await Promise.allSettled([
  tools.read_file({path:'allowed.txt'}),
  tools.read_file({path:'missing.txt'}),
  tools.read_file({path:'/etc/passwd'}),
  tools.read_file({path:'link.txt'})
]);
const absent = ['shell','web_fetch','apply_patch','run_subagent','mcp'].map(name => {
  try { return typeof tools[name]; } catch { return 'unavailable'; }
});
return {
  statuses: probes.map(r => r.status),
  content: probes[0].value.content,
  absent: [...absent, typeof agent, typeof require, typeof process, typeof fetch]
};`;
const output = String(
  await code.execute(
    { code: script, description: 'containment proof', timeout_ms: 10000 },
    { context: { sessionId: 'preflight' } },
    { toolCall: { callId: 'containment' } },
  ),
);
assert.match(output, /fixture-only/);
assert.match(output, /fulfilled/);
assert.match(output, /rejected/);
assert.equal((output.match(/undefined/g) ?? []).length, 4);
assert.equal((output.match(/unavailable/g) ?? []).length, 5);
assert.equal(await readFile(join(root, 'allowed.txt'), 'utf8'), 'fixture-only\n');
await writeFile(join(evidence, 'preflight-output.txt'), output);
await writeFile(
  join(evidence, 'preflight-result.json'),
  JSON.stringify({ passed: true, tools: definition.tools.map((t) => t.name), root, output }, null, 2),
);
console.log('Containment integration preflight passed');
sessionAccess.dispose();
