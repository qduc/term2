/* global process, Buffer, URL, Headers, fetch, AbortSignal */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';

export const MODEL_IDS = { openai: 'gpt-6-luna', anthropic: 'claude-haiku-5-5' };
// Upper bounds use 1.1M input tokens, the most expensive published cache-write
// tier, and 32K output tokens. They also cover chained input absent from the POST.
export const RESERVATIONS = { openai: 0.582, anthropic: 1.18 };
const HOSTS = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' };
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

export function priceUsage(provider, usage, body = {}) {
  if (!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens)) return null;
  if (provider === 'anthropic') {
    const read = usage.cache_read_input_tokens ?? 0;
    const write = usage.cache_creation_input_tokens ?? 0;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    if (![read, write, write1h].every(integer) || write1h > write) return null;
    const total = usage.input_tokens + read + write;
    const factor = total > 100_000 ? 5 : 1;
    return {
      totalInput: total,
      uncachedInput: usage.input_tokens,
      cacheRead: read,
      cacheWrite: write,
      cacheWrite1h: write1h,
      output: usage.output_tokens,
      usd:
        (factor *
          (usage.input_tokens * 0.1 +
            read * 0.01 +
            (write - write1h) * 0.125 +
            write1h * 0.2 +
            usage.output_tokens * 0.5)) /
        1e6,
      priceBasis: 'Published standard rates applied to native provider usage; not an invoice',
    };
  }
  const details = usage.input_tokens_details ?? {};
  const read = details.cached_tokens ?? 0;
  const write = details.cache_write_tokens ?? 0;
  if (![read, write].every(integer) || read + write > usage.input_tokens) return null;
  const long = usage.input_tokens > 272_000;
  const rate = long ? [0.2, 0.02, 0.25, 0.75] : [0.1, 0.01, 0.125, 0.5];
  const retention = body.prompt_cache_retention;
  if (retention && !['in-memory', '30m', '12h', '24h'].includes(retention)) return null;
  if (retention === '12h' || retention === '24h') rate[2] *= 2;
  const fresh = usage.input_tokens - read - write;
  return {
    totalInput: usage.input_tokens,
    uncachedInput: fresh,
    cacheRead: read,
    cacheWrite: write,
    output: usage.output_tokens,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? null,
    usd: (fresh * rate[0] + read * rate[1] + write * rate[2] + usage.output_tokens * rate[3]) / 1e6,
    priceBasis: 'Published standard rates applied to native provider usage; not an invoice',
  };
}

function findUsage(provider, events) {
  if (provider === 'openai') {
    const terminal = events.findLast((e) =>
      ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type),
    );
    return terminal?.response?.usage ?? null;
  }
  if (!events.some((e) => e.type === 'message_stop')) return null;
  const start = events.find((e) => e.type === 'message_start')?.message?.usage;
  const last = events.findLast((e) => e.type === 'message_delta')?.usage;
  return start && last ? { ...start, ...last } : null;
}

function hostedTool(value) {
  if (!value || typeof value !== 'object') return false;
  if (
    typeof value.type === 'string' &&
    /^(web_search|web_fetch|file_search|code_interpreter|code_execution|computer|image_generation|shell$)/.test(
      value.type,
    )
  )
    return true;
  return Object.values(value).some((entry) => (Array.isArray(entry) ? entry.some(hostedTool) : hostedTool(entry)));
}

export class BudgetGateway {
  constructor({ directory, capUsd = 10, fixtureOrigins } = {}) {
    if (!directory || !(capUsd > 0 && capUsd <= 10)) throw new Error('Invalid budget configuration');
    this.directory = directory;
    this.capUsd = capUsd;
    this.fixtureOrigins = fixtureOrigins;
    fs.mkdirSync(directory, { recursive: true });
    this.lock = path.join(directory, 'active.lock');
    fs.mkdirSync(this.lock); // Exclusive single writer; a stale lock fails closed.
    this.lockToken = crypto.randomUUID();
    fs.writeFileSync(
      path.join(this.lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt: new Date().toISOString() }),
    );
    const file = path.join(directory, 'ledger.json');
    this.ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    for (const entry of this.ledger)
      if (
        !Number.isFinite(entry.reservedUsd) ||
        entry.reservedUsd < 0 ||
        (entry.priced && (!Number.isFinite(entry.priced.usd) || entry.priced.usd < 0))
      )
        throw new Error('Invalid saved budget ledger');
    this.runs = new Set();
    this.activeUpstream = false;
    this.halted =
      this.ledger.some((e) => !e.priced || e.httpStatus !== 200) ||
      fs.existsSync(path.join(directory, 'guardrail-stop.json'));
    this.pending = new Set();
    this.secrets = [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter(Boolean);
  }
  exposureUsd() {
    return this.ledger.reduce((sum, entry) => sum + (entry.priced?.usd ?? entry.reservedUsd), 0);
  }
  save() {
    const target = path.join(this.directory, 'ledger.json');
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.ledger, null, 2) + '\n');
    fs.renameSync(`${target}.tmp`, target);
  }
  safe(value) {
    if (typeof value === 'string') {
      for (const secret of this.secrets) value = value.replaceAll(secret, '<credential-redacted>');
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.safe(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          ['encrypted_content', 'signature'].includes(key) && typeof entry === 'string'
            ? {
                redacted: true,
                bytes: Buffer.byteLength(entry),
                sha256: crypto.createHash('sha256').update(entry).digest('hex'),
              }
            : this.safe(entry),
        ]),
      );
    return value;
  }
  async start() {
    this.server = createServer((req, res) => {
      const pending = this.handle(req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error.message) } }));
      });
      this.pending.add(pending);
      pending.finally(() => this.pending.delete(pending));
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  register(runId) {
    if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('Invalid run ID');
    this.runs.add(runId);
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    await Promise.allSettled([...this.pending]);
    const owner = JSON.parse(fs.readFileSync(path.join(this.lock, 'owner.json'), 'utf8'));
    if (owner.token !== this.lockToken) throw new Error('Budget lock ownership changed');
    fs.unlinkSync(path.join(this.lock, 'owner.json'));
    fs.rmdirSync(this.lock);
  }
  async handle(req, res) {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const [provider, runId, ...suffix] = requestUrl.pathname.slice(1).split('/');
    if (req.method !== 'POST' || !MODEL_IDS[provider] || !this.runs.has(runId)) {
      res.writeHead(403);
      res.end('Unregistered budget request');
      return;
    }
    const apiPath = `/${suffix.join('/')}`;
    if (
      apiPath !== (provider === 'openai' ? '/v1/responses' : '/v1/messages') ||
      (requestUrl.search && requestUrl.search !== '?beta=true')
    ) {
      res.writeHead(403);
      res.end('Unsupported paid endpoint');
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Budget request exceeds byte bound');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    const maximum = body.max_output_tokens ?? body.max_tokens;
    if (
      body.model !== MODEL_IDS[provider] ||
      !integer(maximum) ||
      maximum < 1 ||
      maximum > 32_000 ||
      (body.service_tier !== undefined && !['default', 'standard_only'].includes(body.service_tier)) ||
      (body.speed !== undefined && body.speed !== 'standard') ||
      (body.inference_geo !== undefined && body.inference_geo !== 'global') ||
      body.processing_tier !== undefined ||
      body.data_residency !== undefined ||
      Object.keys(req.headers).some((key) => /inference-geo|service-tier|fast-mode|data-residency/.test(key)) ||
      /fast-mode|priority/.test(req.headers['anthropic-beta'] ?? '') ||
      hostedTool(body)
    ) {
      res.writeHead(400);
      res.end('Unbudgeted model, output limit, price modifier or hosted tool');
      return;
    }
    if (provider !== 'openai' || this.halted || this.activeUpstream || this.ledger.length >= 240)
      throw new Error('Experiment halted, concurrent, or request cap');
    if (typeof body.prompt_cache_key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.prompt_cache_key))
      throw new Error('Invalid cache key');
    const guardrailResult = body.input?.find(
      (item) =>
        item.type === 'function_call_output' &&
        /Shell sandbox unavailable|Tool execution was not approved|Heuristic validation failed|LLM auto-approval evaluation failed|LLM evaluation rejected|Sandbox denied read|Sandbox blocked/.test(
          String(item.output ?? ''),
        ),
    );
    if (guardrailResult) {
      this.halted = true;
      fs.writeFileSync(
        path.join(this.directory, 'guardrail-stop.json'),
        JSON.stringify(
          {
            runId,
            at: new Date().toISOString(),
            reason: 'Tool capability/approval failure before further paid dispatch',
            toolResult: this.safe(String(guardrailResult.output).slice(0, 1600)),
          },
          null,
          2,
        ) + '\n',
      );
      throw new Error('Capability guardrail failed; no further paid dispatch');
    }
    const reservedUsd = RESERVATIONS[provider];
    if (
      this.exposureUsd() + reservedUsd > this.capUsd - 0.01 ||
      this.ledger.filter((r) => r.runId === runId).length >= 20
    ) {
      res.writeHead(402);
      res.end('Comparison budget exhausted');
      return;
    }
    // Reservation is persisted synchronously BEFORE the first upstream await.
    const entry = {
      id: String(this.ledger.length + 1).padStart(5, '0'),
      runId,
      provider,
      mode: this.fixtureOrigins ? 'fixture' : 'live',
      startedAt: new Date().toISOString(),
      reservedUsd,
      status: 'reserved',
      requestBytes: raw.length,
      requestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      priced: null,
    };
    this.activeUpstream = true;
    this.ledger.push(entry);
    this.save();
    const prefix = path.join(this.directory, entry.id);
    fs.writeFileSync(`${prefix}-request.json`, JSON.stringify(this.safe(body), null, 2) + '\n');
    const headers = new Headers(req.headers);
    for (const name of ['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'accept-encoding'])
      headers.delete(name);
    headers.set('accept-encoding', 'identity');
    if (provider === 'openai')
      headers.set('authorization', `Bearer ${this.fixtureOrigins ? 'fixture' : process.env.OPENAI_API_KEY}`);
    else headers.set('x-api-key', this.fixtureOrigins ? 'fixture' : process.env.ANTHROPIC_API_KEY ?? '');
    const allow = ['session-id', 'x-client-request-id', 'x-stainless-retry-count', 'openai-beta', 'user-agent'];
    entry.incomingHeaders = Object.fromEntries(allow.filter((k) => headers.has(k)).map((k) => [k, headers.get(k)]));
    if (headers.has('session-id')) throw new Error('Unexpected ambient session-id');
    if (runId.endsWith('-affinity')) headers.set('session-id', body.prompt_cache_key);
    entry.outgoingHeaders = Object.fromEntries(allow.filter((k) => headers.has(k)).map((k) => [k, headers.get(k)]));
    entry.outgoingBodySha256 = crypto.createHash('sha256').update(raw).digest('hex');
    this.save();
    let response;
    const received = [];
    try {
      response = await fetch(`${this.fixtureOrigins?.[provider] ?? HOSTS[provider]}${apiPath}${requestUrl.search}`, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(300_000),
      });
      entry.httpStatus = response.status;
      entry.providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
      entry.routingResponseHeaders = Object.fromEntries(
        ['openai-processing-ms', 'openai-version', 'openai-model', 'x-served-by', 'x-cache', 'cf-ray']
          .filter((k) => response.headers.has(k))
          .map((k) => [k, response.headers.get(k)]),
      );
      // Preserve continuation, retry and routing headers; fetch decoded encoding.
      const responseHeaders = Object.fromEntries(response.headers.entries());
      for (const key of ['content-length', 'content-encoding', 'connection', 'transfer-encoding'])
        delete responseHeaders[key];
      res.writeHead(response.status, responseHeaders);
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('Budget response exceeds capture bound');
        received.push(Buffer.from(chunk));
        if (!res.destroyed && !res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
      const text = Buffer.concat(received).toString();
      const events = text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .flatMap((line) => {
          try {
            return [JSON.parse(line.slice(6))];
          } catch {
            return [];
          }
        });
      const usage = findUsage(provider, events);
      entry.usage = usage;
      entry.priced = priceUsage(provider, usage, body);
      entry.status = entry.priced ? 'metered' : 'unknown_usage_reservation_retained';
      const terminal = events.findLast((e) =>
        ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type),
      )?.response;
      const unsandboxed = terminal?.output?.some((item) => {
        if (item.type !== 'function_call' || item.name !== 'shell') return false;
        try {
          return JSON.parse(item.arguments).sandbox === 'unsandboxed';
        } catch {
          return false;
        }
      });
      if (unsandboxed) {
        this.halted = true;
        fs.writeFileSync(
          path.join(this.directory, 'guardrail-stop.json'),
          JSON.stringify(
            {
              runId,
              requestId: entry.id,
              at: new Date().toISOString(),
              reason: 'Model requested an unsandboxed shell call; cohort guardrail failed',
            },
            null,
            2,
          ) + '\n',
        );
      }

      entry.responseSha256 = crypto.createHash('sha256').update(text).digest('hex');
      fs.writeFileSync(
        `${prefix}-response.json`,
        JSON.stringify(this.safe(events.length ? events : { httpStatus: response.status, body: text }), null, 2) + '\n',
      );
    } catch (error) {
      entry.status = 'transport_error_reservation_retained';
      entry.error = this.safe(String(error.message));
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    } finally {
      entry.finishedAt = new Date().toISOString();
      this.activeUpstream = false;
      if (!entry.priced || entry.httpStatus !== 200) this.halted = true;
      this.save();
      res.end();
    }
  }
}
