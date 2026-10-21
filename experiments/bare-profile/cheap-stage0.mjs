import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateOracles, makeFixture } from './cheap-fixtures.mjs';
import { SessionBrowser } from '../../dist/services/conversation/session-browser.js';

const output = path.resolve(process.argv[2]);
assert(!fs.existsSync(output), 'Refuse to overwrite evidence');
fs.mkdirSync(output, { recursive: true });
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-oracles-'));
const oracles = await validateOracles(privateRoot);
const sessionFixture = await makeFixture(path.join(privateRoot, 'session-access'), 'sessions', randomUUID());
const previous = process.env.TERM2_CONVERSATIONS_DIR;
process.env.TERM2_CONVERSATIONS_DIR = sessionFixture.sessionDir;
const browser = new SessionBrowser(() => ({ projectPath: sessionFixture.workspace }), { backend: 'canonical' });
let session;
try {
  const found = await browser.search({ query: 'shipping', limit: 3, maxChars: 3000 });
  assert(JSON.stringify(found).includes(sessionFixture.expected.dialect));
  const missing = await browser.read({ id: 'missing-session' });
  assert(missing.error);
  session = { seededDecisionRetrieved: true, missingSessionRejected: true };
} finally {
  await browser.close();
  if (previous === undefined) delete process.env.TERM2_CONVERSATIONS_DIR;
  else process.env.TERM2_CONVERSATIONS_DIR = previous;
}
const externalFixture = await makeFixture(path.join(privateRoot, 'loopback'), 'external', randomUUID());
const server = http.createServer((req, res) => {
  if (req.url !== '/region') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(externalFixture.expected));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let connector;
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await globalThis.fetch(url + '/region')).json(), externalFixture.expected);
  assert.equal((await globalThis.fetch(url + '/missing')).status, 404);
  connector = {
    loopbackAuthoritativeQueryPassed: true,
    missingEndpointRejected: true,
    candidateAddition: 'unavailable: Bare suppresses run_code, the only MCP registration surface',
  };
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
const receipt = {
  paidCalls: 0,
  oracles,
  session,
  connector,
  note: 'Fixture correctness is not candidate completion evidence. No answers from these oracle validation homes are reused for screens.',
};
fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
