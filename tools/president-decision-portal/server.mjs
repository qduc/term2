import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const host = process.env.PRESIDENT_PORTAL_HOST ?? '192.168.0.88';
const port = Number.parseInt(process.env.PRESIDENT_PORTAL_PORT ?? '8787', 10);
const stateDirectory = process.env.PRESIDENT_PORTAL_STATE_DIR
  ?? '/home/qduc/.agents/runtime/president-decision-portal';
const tokenPath = path.join(stateDirectory, 'access-token');
const eventPath = path.join(stateDirectory, 'decisions.jsonl');
const cookieName = 'president_decision_portal';
const maxRequestBytes = 16_384;

const decisions = [
  {
    id: 'D5',
    title: 'Record an explicit denied tool approval honestly',
    question: 'When a batch approval explicitly denies a tool call, what durable outcome should the system record?',
    evidence: 'The current batch path records an approved decision while skipping the denied call. That makes the durable audit record contradict the observable outcome.',
    recommendation: 'Record an explicit rejection for every denied call and do not execute it.',
    options: [
      ['explicit_rejection', 'Record “rejected” for each denied call and skip execution.'],
      ['neutral_skip', 'Record a neutral “skipped” outcome without saying whether it was denied.'],
      ['retain_current', 'Keep the current approved-plus-skip behavior.'],
    ],
  },
  {
    id: 'D8',
    title: 'Preserve the kind of approval grant in the durable log',
    question: 'Should the durable approval-resolution record distinguish the kind of grant rather than only y/n?',
    evidence: 'The existing approval_resolved event collapses all grants to y or n, so later audit and replay cannot distinguish important approval modes.',
    recommendation: 'Add a backward-compatible grantKind field while preserving existing y/n readers.',
    options: [
      ['additive_grant_kind', 'Add a backward-compatible grantKind field alongside y/n.'],
      ['breaking_union', 'Replace y/n with a new full union now, accepting a migration break.'],
      ['retain_collapsed', 'Keep the current collapsed y/n record.'],
    ],
  },
  {
    id: 'D10',
    title: 'Align non-interactive approval of Yellow-risk tools',
    question: 'May non-interactive mode accept a metadata-less { approved: true } response for Yellow-risk tools?',
    evidence: 'Interactive approval requires risk, authority, confidence, and source context. Non-interactive currently accepts an approval object without that provenance.',
    recommendation: 'Reject Yellow-risk approval unless the required provenance is present; keep the characterization red until a separately authorized repair.',
    options: [
      ['require_provenance', 'Require the same provenance for Yellow-risk approval in non-interactive mode.'],
      ['intentional_mismatch', 'Keep the non-interactive metadata-less approval as an intentional exception.'],
      ['reject_all_yellow', 'Reject every Yellow-risk approval in non-interactive mode.'],
    ],
  },
];

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

async function ensureToken() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try {
    return (await readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = randomBytes(24).toString('base64url');
    await writeFile(tokenPath, `${generated}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    return generated;
  }
}

async function readResponses() {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function stableEquals(left, right) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function hasSession(request, token) {
  const value = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return Boolean(value) && stableEquals(value, token);
}

function isLocalNetwork(request) {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1'
    || remote.startsWith('192.168.0.') || remote.startsWith('::ffff:192.168.0.');
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response, status, body, contentType = 'text/html; charset=utf-8', headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  response.end(body);
}

function page(title, content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#10151c; color:#eef2f6; }
  body { max-width:900px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:2rem; letter-spacing:-.03em; margin:0 0 8px; } .lede{color:#b6c2d0;margin:0 0 30px;}
  .card { background:#19212c; border:1px solid #2b3a4b; border-radius:14px; padding:24px; margin:18px 0; }
  .id { color:#81d4fa; font-weight:700; letter-spacing:.08em; font-size:.8rem; }
  .evidence,.recommendation { padding:12px 14px; border-radius:9px; margin:14px 0; line-height:1.45; }
  .evidence { background:#232d39; color:#d3dce8; } .recommendation { background:#18342d; color:#c8f5de; }
  label { display:block; margin:10px 0; padding:10px; border:1px solid #34475b; border-radius:8px; cursor:pointer; }
  label:hover { border-color:#81d4fa; } textarea,input { box-sizing:border-box; width:100%; border-radius:8px; border:1px solid #42576e; background:#101820; color:#fff; padding:10px; font:inherit; }
  button { background:#81d4fa; color:#062330; border:0; border-radius:8px; padding:10px 14px; font-weight:700; cursor:pointer; }
  button:hover { background:#b5e8ff; } .answer { color:#c8f5de; font-weight:600; } .muted {color:#aab7c6;font-size:.9rem;} .error{color:#ffc2c2;}
</style></head><body>${content}</body></html>`;
}

function loginPage(error = '') {
  return page('President decision portal', `<main><h1>President decision portal</h1><p class="lede">Private LAN access. Enter the access token supplied by Engineering.</p>
  <section class="card"><form method="post" action="/login"><label>Access token<input name="token" type="password" autocomplete="current-password" required autofocus></label>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<button type="submit">Open decisions</button></form></section></main>`);
}

function decisionsPage(events) {
  const latest = new Map(events.filter((event) => event.kind === 'decision_response').map((event) => [event.decisionId, event]));
  const cards = decisions.map((decision) => {
    const response = latest.get(decision.id);
    const selected = response?.optionId;
    const options = decision.options.map(([id, label]) => `<label><input type="radio" name="optionId" value="${id}" ${selected === id ? 'checked' : ''} required> ${escapeHtml(label)}</label>`).join('');
    const answer = response ? `<p class="answer">Recorded: ${escapeHtml(response.optionLabel)} · ${escapeHtml(response.recordedAt)}</p>${response.note ? `<p class="muted">Note: ${escapeHtml(response.note)}</p>` : ''}` : '<p class="muted">Awaiting your decision.</p>';
    return `<section class="card"><div class="id">${decision.id}</div><h2>${escapeHtml(decision.title)}</h2><p>${escapeHtml(decision.question)}</p>
      <div class="evidence"><strong>Current evidence:</strong><br>${escapeHtml(decision.evidence)}</div>
      <div class="recommendation"><strong>Engineering recommendation:</strong><br>${escapeHtml(decision.recommendation)}</div>${answer}
      <form method="post" action="/decision/${decision.id}">${options}<label>Optional rationale<textarea name="note" maxlength="2000" rows="3" placeholder="Your reasoning or constraints"></textarea></label><button type="submit">Record ${decision.id} decision</button></form></section>`;
  }).join('');
  return page('President decision portal', `<main><h1>President decision portal</h1><p class="lede">Contract 11 owner decisions. Each response is appended to the local decision ledger and remains visible here.</p>${cards}<p class="muted">LAN-only service. Recording a decision does not authorize a production repair, commit, merge, push, or activation.</p></main>`);
}

async function main() {
  const token = await ensureToken();
  const server = createServer(async (request, response) => {
    try {
      if (!isLocalNetwork(request)) return send(response, 403, page('Forbidden', '<h1>Forbidden</h1><p>LAN access only.</p>'));
      const url = new URL(request.url, `http://${request.headers.host ?? host}`);
      if (request.method === 'GET' && url.pathname === '/') {
        if (!hasSession(request, token)) return send(response, 200, loginPage());
        return send(response, 200, decisionsPage(await readResponses()));
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        const supplied = new URLSearchParams(await readBody(request)).get('token') ?? '';
        if (!stableEquals(supplied, token)) return send(response, 401, loginPage('That access token is not valid.'));
        return send(response, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      }
      const match = request.method === 'POST' && url.pathname.match(/^\/decision\/(D5|D8|D10)$/);
      if (match) {
        if (!hasSession(request, token)) return send(response, 401, loginPage('Please sign in again.'));
        const decision = decisions.find((item) => item.id === match[1]);
        const form = new URLSearchParams(await readBody(request));
        const optionId = form.get('optionId') ?? '';
        const option = decision.options.find(([id]) => id === optionId);
        if (!option) return send(response, 400, page('Invalid decision', '<h1>Choose one of the listed options.</h1>'));
        const note = (form.get('note') ?? '').trim();
        const event = { kind: 'decision_response', decisionId: decision.id, optionId, optionLabel: option[1], note, recordedAt: new Date().toISOString() };
        await appendFile(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        return send(response, 303, '', 'text/plain', { Location: '/' });
      }
      return send(response, 404, page('Not found', '<h1>Not found</h1>'));
    } catch (error) {
      return send(response, 500, page('Portal error', `<h1>Portal error</h1><p>${escapeHtml(error.message)}</p>`));
    }
  });
  server.listen(port, host, () => {
    console.log(`President decision portal: http://${host}:${port}`);
    console.log(`Access token: ${token}`);
    console.log(`Decision ledger: ${eventPath}`);
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
