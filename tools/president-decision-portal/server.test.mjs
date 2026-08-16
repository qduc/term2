import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('requires a token and appends a selected decision', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'president-portal-'));
  const port = 18_787;
  const child = spawn(process.execPath, ['tools/president-decision-portal/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PRESIDENT_PORTAL_HOST: '127.0.0.1', PRESIDENT_PORTAL_PORT: String(port), PRESIDENT_PORTAL_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => (chunk.toString().includes('President decision portal') ? resolve() : undefined));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await unauthenticated.text(), /Access token/);
    const token = (await readFile(path.join(state, 'access-token'), 'utf8')).trim();
    const login = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    const submitted = await fetch(`http://127.0.0.1:${port}/decision/D5`, {
      method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ optionId: 'explicit_rejection', note: 'Preserve audit truth.' }), redirect: 'manual',
    });
    assert.equal(submitted.status, 303);
    const ledger = await readFile(path.join(state, 'decisions.jsonl'), 'utf8');
    assert.match(ledger, /explicit_rejection/);
  } finally {
    child.kill();
    await rm(state, { recursive: true, force: true });
  }
});
