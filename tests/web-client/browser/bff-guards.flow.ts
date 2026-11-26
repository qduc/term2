import http from 'node:http';
import { expect } from '@playwright/test';
import { expectNoRunningTurn, openDraftChat, send, test, turns } from './flow-helpers.js';

/**
 * The rules the packaged web server (BFF) applies before anything reaches the gateway, checked against
 * the real built `term2-web` over raw HTTP: a browser cannot forge `Host`, but another page or a DNS
 * rebinding attack can make one arrive, so these are the boundary that matters.
 *
 * Moved from the `node:test` files that used to sit under `web-client/lib/` and that nothing ran.
 */

type Reply = {
  status: number;
  text: string;
  json: () => { error?: { code?: string; message?: string; details?: unknown } };
};

/** One request with exactly the headers given; `host` defaults to the server's own address. */
function raw(
  origin: string,
  method: string,
  pathname: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: pathname,
        headers: { host: url.host, ...options.headers },
        setHost: false,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text, json: () => JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

const json = { 'content-type': 'application/json' };

/** The BFF's own refusal of a request it judged invalid, as opposed to an answer from the gateway. */
const isValidationError = (reply: Reply): boolean => {
  if (reply.status !== 400) return false;
  try {
    return reply.json().error?.code === 'validation_error';
  } catch {
    return false;
  }
};

test('the packaged web server refuses non-local requests and malformed input before the gateway', async ({
  page,
  launch,
}) => {
  const prompt = 'make a chat for the guard checks';
  const app = await launch({ scripts: { [prompt]: [{ text: 'chat ready' }] } });
  await openDraftChat(page, app);
  await send(page, prompt);
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  const sessionId = new URL(page.url()).searchParams.get('agentSession')!;
  expect(sessionId).toMatch(/^conv_/);
  const local = new URL(app.origin);
  const abortPath = `/api/agent/sessions/${sessionId}/abort`;

  await test.step('a non-local Host is refused for reads and writes', async () => {
    for (const host of ['evil.test', `evil.test:${local.port}`, 'evil.test@localhost', '0.0.0.0']) {
      const read = await raw(app.origin, 'GET', '/api/agent/workspaces', { headers: { host } });
      expect(read.status, `GET under Host ${host}`).toBe(403);
      const write = await raw(app.origin, 'POST', abortPath, {
        headers: { ...json, host },
        body: JSON.stringify({ turnId: 'turn_1' }),
      });
      expect(write.status, `POST under Host ${host}`).toBe(403);
    }
    // Both local names are the server's own.
    for (const host of [`127.0.0.1:${local.port}`, `localhost:${local.port}`]) {
      expect((await raw(app.origin, 'GET', '/api/agent/workspaces', { headers: { host } })).status).toBe(200);
    }
  });

  await test.step('a state-changing request needs a JSON body and, when it names one, a local Origin', async () => {
    const body = JSON.stringify({ turnId: 'turn_1' });
    const noType = await raw(app.origin, 'POST', abortPath, { body });
    expect(isValidationError(noType)).toBe(true);
    expect(noType.json().error?.message).toMatch(/content-type/i);
    const textType = await raw(app.origin, 'POST', abortPath, { headers: { 'content-type': 'text/plain' }, body });
    expect(isValidationError(textType)).toBe(true);

    for (const origin of [
      'https://evil.test',
      'http://evil.test@localhost',
      `http://user:pw@127.0.0.1:${local.port}`,
      'null',
    ]) {
      const reply = await raw(app.origin, 'POST', abortPath, { headers: { ...json, origin }, body });
      expect(isValidationError(reply), `Origin ${origin}`).toBe(true);
      expect(reply.json().error?.message).toMatch(/origin/i);
    }

    // No Origin (a same-origin fetch from some clients), the page's own, or another local port: the
    // guards let it through and the gateway answers.
    for (const headers of [
      json,
      { ...json, origin: app.origin, 'content-type': 'Application/JSON; charset=utf-8' },
      { ...json, origin: 'http://127.0.0.1:9' },
    ]) {
      const reply = await raw(app.origin, 'POST', abortPath, { headers, body });
      expect(isValidationError(reply), JSON.stringify(headers)).toBe(false);
      expect(reply.status).not.toBe(403);
    }
  });

  await test.step('request bodies carry exactly the gateway fields, with opaque IDs and bounded text', async () => {
    const post = (pathname: string, payload: unknown) =>
      raw(app.origin, 'POST', pathname, { headers: json, body: JSON.stringify(payload) });

    expect(isValidationError(await post(abortPath, { turnId: 'turn_1', extra: true }))).toBe(true);
    expect(isValidationError(await post(abortPath, { turnId: 'not valid' }))).toBe(true);
    expect(isValidationError(await post(abortPath, {}))).toBe(true);
    expect(isValidationError(await raw(app.origin, 'POST', abortPath, { headers: json, body: '[1]' }))).toBe(true);

    const commands = `/api/agent/sessions/${sessionId}/commands`;
    expect(isValidationError(await post(commands, { commandId: 'compact' }))).toBe(true);
    expect(isValidationError(await post(commands, { commandId: 'compact', clientRequestId: 'not valid' }))).toBe(true);
    expect(isValidationError(await post(commands, { commandId: 'rm -rf', clientRequestId: 'req_1' }))).toBe(true);

    const interaction = `/api/agent/sessions/${sessionId}/interactions/turn_1-approval-1`;
    const tooLong = 'x'.repeat(16_385);
    expect(isValidationError(await post(interaction, { revision: 1, answer: 'bad\u0000' }))).toBe(true);
    expect(isValidationError(await post(interaction, { revision: 1, answer: tooLong }))).toBe(true);
    expect(isValidationError(await post(interaction, { revision: 1, answer: 'ok', rejectionReason: tooLong }))).toBe(
      true,
    );
    // JSON whitespace is ordinary text: the BFF passes it on and the gateway answers (no such request).
    const whitespace = await post(interaction, { revision: 1, answer: 'line 1\nline 2\r\t' });
    expect(isValidationError(whitespace), whitespace.text).toBe(false);
  });

  await test.step('event cursors are sequence numbers; page cursors are opaque base64url', async () => {
    const opaque = 'eyJvZmZzZXQiOjIwfQ';
    const events = `/api/agent/sessions/${sessionId}/events`;
    expect(isValidationError(await raw(app.origin, 'GET', `${events}?after=${opaque}`))).toBe(true);
    expect(isValidationError(await raw(app.origin, 'GET', `${events}?after=-1`))).toBe(true);
    expect(isValidationError(await raw(app.origin, 'GET', `/api/agent/sessions?limit=20&cursor=abc%2B%2F%3D`))).toBe(
      true,
    );
    const page = await raw(app.origin, 'GET', `/api/agent/sessions?limit=20&cursor=${opaque}`);
    expect(isValidationError(page), page.text).toBe(false);
  });

  await test.step('a settings write against a stale revision returns the current revision and projection', async () => {
    const current = await raw(app.origin, 'GET', '/api/term2/settings');
    expect(current.status).toBe(200);
    const { revision } = JSON.parse(current.text) as { revision: string };
    const conflict = await raw(app.origin, 'PUT', '/api/term2/settings', {
      headers: json,
      body: JSON.stringify({
        expectedRevision: `${revision}-stale`,
        changes: [{ key: 'agent.contextCompaction.enabled', value: true }],
      }),
    });
    expect(conflict.status, conflict.text).toBe(409);
    const error = conflict.json().error!;
    expect(error.code).toBe('settings_conflict');
    expect(error.details).toMatchObject({ currentRevision: revision, projection: { revision } });
  });

  expect(app.model.unscripted()).toEqual([]);
});
