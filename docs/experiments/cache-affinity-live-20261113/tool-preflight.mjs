/* global process, Buffer, console */
// No paid mode: every model request terminates at this loopback fixture.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BudgetGateway } from './budget-gateway.mjs';
import { runCandidate } from './run-comparison.mjs';
import { assertFreshBuild } from '../../../scripts/build-provenance.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
assertFreshBuild(repo, 'direct');
const buildReceipt = JSON.parse(fs.readFileSync(path.join(repo, 'dist/.term2-build-provenance.json'), 'utf8'));
process.env.BENCH_MEASURED_SOURCE_COMMIT = buildReceipt.inputs.head;

const root = process.env.BENCH_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Set a new absolute BENCH_ROOT');
if (process.argv.includes('--live')) throw new Error('This preflight has no paid mode');
const shell = (command) => ({
  command,
  description: 'No-cost capability preflight',
  timeout_ms: 10000,
  max_output_length: 16000,
  sandbox: 'default',
});
const patch =
  '*** Begin Patch\n*** Update File: src/pages.mjs\n@@\n-  do { const page = await fetchPage({ cursor, signal: options.signal }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);\n+  do { const page = await fetchPage({ cursor, signal: options.signal }); items.push(...page.items); cursor = page.nextCursor; } while (cursor !== null && cursor !== undefined);\n*** End Patch\n';
const steps = [
  { name: 'shell', arguments: shell('cat .agents/skills/node-contracts/SKILL.md') },
  { name: 'apply_patch', arguments: { patch } },
  { name: 'shell', arguments: shell('node --test test/public.test.mjs') },
];
const receipts = [];
const errors = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const n = receipts.length;
  receipts.push(body);
  if (req.url !== '/v1/responses' || n > steps.length) {
    errors.push('Unexpected request shape or count');
    res.writeHead(400).end();
    return;
  }
  if (n > 0) {
    const result = body.input.find(
      (item) => item.type === 'function_call_output' && item.call_id === `preflight-call-${n - 1}`,
    );
    const text = String(result?.output ?? '');
    const accepted = [
      text.includes('Read the task') && text.includes('Do not mutate caller inputs'),
      /Updated.*src\/pages\.mjs/.test(text),
      text.startsWith('exit 0\n') && /\bpass 2\b/.test(text) && /\bfail 0\b/.test(text),
    ][n - 1];
    if (!accepted) errors.push(`Step ${n - 1} tool result did not establish success: ${text.slice(0, 1200)}`);
  }
  const step = steps[n];
  const item = step
    ? {
        type: 'function_call',
        id: `preflight-item-${n}`,
        call_id: `preflight-call-${n}`,
        name: step.name,
        arguments: JSON.stringify(step.arguments),
        status: 'completed',
      }
    : {
        type: 'message',
        id: 'preflight-final',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'PREFLIGHT_OK', annotations: [] }],
        status: 'completed',
      };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  send({ type: 'response.output_item.added', output_index: 0, item });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({
    type: 'response.completed',
    response: {
      id: `preflight-response-${n}`,
      status: 'completed',
      model: body.model,
      output: [item],
      usage: {
        input_tokens: 100,
        output_tokens: 4,
        total_tokens: 104,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const gateway = await new BudgetGateway({
  directory: path.join(root, 'wire-fixture'),
  capUsd: 2,
  fixtureOrigins: { openai: origin },
}).start();
let result;
try {
  result = await runCandidate(
    { id: 'tool-preflight', provider: 'openai', arm: 'tool-preflight', task: 'pagination', rep: 0 },
    gateway,
    { fixture: true },
  );
} finally {
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
}
const artifact = path.join(root, 'runs/fixture-openai-tool-preflight/artifact/src/pages.mjs');
const sourceEdited = fs.readFileSync(artifact, 'utf8').includes('cursor !== null && cursor !== undefined');
const passed =
  result.exitCode === 0 &&
  result.publicTestsExitCode === 0 &&
  receipts.length === 4 &&
  errors.length === 0 &&
  sourceEdited;
const summary = {
  passed,
  mode: 'loopback-fixture-only',
  paidRequests: 0,
  paidCostUsd: 0,
  requests: receipts.length,
  errors,
  sourceEdited,
  externalPublicTestsExitCode: result.publicTestsExitCode,
  sandboxModeRequested: 'default',
  unsandboxedRequests: 0,
  choreModelConfigured: false,
  securitySettingChanges: [],
  pathRepair: '/workspace/.local/usr/bin',
  socatBinarySha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync('/workspace/.local/usr/bin/socat'))
    .digest('hex'),
  scriptSha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex'),
};
fs.copyFileSync(path.join(repo, 'dist/.term2-build-provenance.json'), path.join(root, 'build-receipt.json'));
fs.writeFileSync(path.join(root, 'tool-preflight.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (!passed) process.exitCode = 1;
