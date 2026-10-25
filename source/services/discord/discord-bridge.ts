import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import {
  DiscordOutboundServer,
  sameDiscordBinding,
  type DiscordBinding,
  type DiscordSendResult,
} from './discord-outbound.js';
import {
  isControlSocketName,
  listControlAdvertisements,
  readProcStartTime,
  CONTROL_MAX_FRAME_BYTES,
} from '../control-socket/control-socket.js';

export interface DiscordBridgeConfig {
  channelId: string;
  humanUserId: string;
  coordinator: string;
  stateDir: string;
  maxHops: number;
}
interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
  webhook_id?: string;
}
interface Binding {
  socketPath: string;
  startedAt: string;
  sessionId: string;
}
interface Job {
  id: string;
  alias: string;
  text: string;
  origin: { kind: 'human' | 'agent'; sender: string };
  hops: number;
  state: 'new' | 'dispatching' | 'accepted' | 'done' | 'uncertain';
  noRoute?: boolean;
  binding: Binding;
}
interface Outgoing {
  id: string;
  content: string;
  state: 'queued' | 'sending' | 'sent' | 'uncertain';
}
const outboxStates = ['queued', 'sending', 'sent', 'uncertain'];
function validOutbox(value: unknown): value is Outgoing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return (
    Object.keys(output).length === 3 &&
    Object.keys(output).every((key) => ['id', 'content', 'state'].includes(key)) &&
    typeof output.id === 'string' &&
    /^[a-f0-9]{24}$/.test(output.id) &&
    typeof output.content === 'string' &&
    outboxStates.includes(output.state as string)
  );
}
interface Proactive {
  binding: DiscordBinding;
  requestId: string;
  digest: string;
  alias: string;
  channelId: string;
  outputs: string[];
}
interface Journal {
  proactive?: Proactive[];
  v: 2;
  fingerprint: string;
  cursor: string;
  paused: boolean;
  stopPending?: boolean;
  retryAt?: number;
  jobs: Job[];
  outbox: Outgoing[];
}
const snowflakePattern = /^[0-9]{1,24}$/;

function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const keys = Object.keys(binding);
  return (
    keys.length === 3 &&
    keys.every((key) => ['socketPath', 'sessionId', 'startedAt'].includes(key)) &&
    typeof binding.socketPath === 'string' &&
    typeof binding.sessionId === 'string' &&
    typeof binding.startedAt === 'string'
  );
}
const jobStates = ['new', 'dispatching', 'accepted', 'done', 'uncertain'];
function validJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const origin = job.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
  const source = origin as Record<string, unknown>;
  return (
    Object.keys(job).every((key) =>
      ['id', 'alias', 'text', 'origin', 'hops', 'state', 'noRoute', 'binding'].includes(key),
    ) &&
    typeof job.id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(job.id) &&
    typeof job.alias === 'string' &&
    isControlSocketName(job.alias) &&
    typeof job.text === 'string' &&
    typeof job.hops === 'number' &&
    Number.isInteger(job.hops) &&
    job.hops >= 0 &&
    job.hops <= 8 &&
    jobStates.includes(job.state as string) &&
    (job.noRoute === undefined || typeof job.noRoute === 'boolean') &&
    validBinding(job.binding) &&
    Object.keys(source).length === 2 &&
    ['human', 'agent'].includes(source.kind as string) &&
    typeof source.sender === 'string' &&
    (source.kind === 'human' ? snowflakePattern.test(source.sender) : isControlSocketName(source.sender))
  );
}

export type DiscordStateErrorCode = 'pinned_session_schema' | 'journal_state';

/** Tag state/schema failures so callers map fixed guidance without parsing error text. */
function stateError(code: DiscordStateErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Explicit discriminator for bridge schema/journal failures; everything else stays generic. */
export function discordStateErrorCode(error: unknown): DiscordStateErrorCode | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'pinned_session_schema' || code === 'journal_state' ? code : undefined;
}

/** Validate a private single-channel bridge configuration; no token belongs in this file. */
export function parseDiscordBridgeConfig(value: unknown): DiscordBridgeConfig {
  const config = value as DiscordBridgeConfig;
  if (config && typeof config === 'object' && Object.hasOwn(config, 'sessions'))
    throw stateError(
      'pinned_session_schema',
      'Pinned-session schema has been replaced; archive old state and use a fresh stateDir/config',
    );
  if (
    !config ||
    typeof config !== 'object' ||
    Object.keys(config).some(
      (key) => !['channelId', 'humanUserId', 'coordinator', 'stateDir', 'maxHops'].includes(key),
    ) ||
    typeof config.channelId !== 'string' ||
    !snowflakePattern.test(config.channelId) ||
    typeof config.humanUserId !== 'string' ||
    !snowflakePattern.test(config.humanUserId) ||
    typeof config.coordinator !== 'string' ||
    !isControlSocketName(config.coordinator) ||
    typeof config.stateDir !== 'string' ||
    !path.isAbsolute(config.stateDir)
  )
    throw new Error('Invalid Discord bridge config');
  const maxHops = config.maxHops ?? 4;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 8) throw new Error('Invalid Discord hop limit');
  return { ...config, maxHops };
}

/** One bounded newline-framed RPC; transport failure is ambiguous for mutations, never retried here. */
export function callDiscordControl(socketPath: string, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let bytes = Buffer.alloc(0);
    let hello = false;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(10_000, () => finish(new Error('Control timeout')));
    socket.on('error', () => finish(new Error('Control unavailable')));
    socket.on('close', () => finish(new Error('Control disconnected')));
    socket.on('connect', () => socket.write(JSON.stringify({ v: 1, id: 'hello', method: 'hello' }) + '\n'));
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > CONTROL_MAX_FRAME_BYTES) return finish(new Error('Control frame too large'));
      let newline: number;
      while ((newline = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, newline).toString('utf8');
        bytes = bytes.subarray(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.v !== 1 || response.id !== (hello ? 'call' : 'hello'))
            throw new Error('Invalid control response');
          if (!response.ok) {
            const error = new Error('Control rejected request') as Error & { code?: string };
            error.code = typeof response.error?.code === 'string' ? response.error.code : 'internal';
            return finish(error);
          }
          if (!hello) {
            hello = true;
            socket.write(JSON.stringify({ v: 1, id: 'call', method, params }) + '\n');
          } else return finish(undefined, response.result);
        } catch {
          return finish(new Error('Invalid control response'));
        }
      }
    });
  });
}

function atomicSave(file: string, data: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

function chunks(text: string): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > 1700) {
    let size = 1700;
    if (/[\uD800-\uDBFF]/.test(rest[size - 1]!)) size--;
    result.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest) result.push(rest);
  return result;
}

/**
 * Serial Discord REST adapter attached to existing explicitly opted-in terminal sessions.
 * tick() is single-owner: durable state precedes effects; ambiguous effects are quarantined,
 * not automatically replayed. No history scan or Discord bot message can wake a session.
 */
export class DiscordBridge {
  readonly #config: DiscordBridgeConfig;
  readonly #token: string;
  readonly #runtimeDir: string;
  readonly #apiBase: string;
  readonly #warn: (message: string) => void;
  readonly #file: string;
  readonly #lock: string;
  #journal!: Journal;
  #retryAt = 0;
  #readFailures = 0;
  #running = false;
  #owned = false;
  #failed = false;
  #outbound?: DiscordOutboundServer;

  constructor(
    config: DiscordBridgeConfig,
    token: string,
    options: {
      runtimeDir: string;
      /** Test-only loopback HTTP fixture; production always uses Discord v10. */
      apiBase?: string;
      warn?: (message: string) => void;
    },
  ) {
    this.#config = parseDiscordBridgeConfig(config);
    if (!token || /[\s\r\n]/.test(token)) throw new Error('Discord bot token missing or invalid');
    if (!path.isAbsolute(options.runtimeDir)) throw new Error('Invalid control runtime directory');
    const base = options.apiBase ?? 'https://discord.com/api/v10';
    const url = new URL(base);
    if (
      base !== 'https://discord.com/api/v10' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      throw new Error('Invalid Discord transport endpoint');
    }
    this.#token = token;
    this.#runtimeDir = options.runtimeDir;
    this.#apiBase = base;
    this.#warn = options.warn ?? (() => {});
    this.#file = path.join(config.stateDir, 'journal.json');
    this.#lock = path.join(config.stateDir, 'owner.json');
  }

  /** Acquire private state ownership and pin aliases to the currently advertised process epochs. */
  open(): void {
    const { stateDir } = this.#config;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(stateDir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Discord state directory must be owned by this user and mode 0700');
    }
    if (fs.existsSync(this.#lock)) {
      const owner = JSON.parse(fs.readFileSync(this.#lock, 'utf8'));
      if (!Number.isInteger(owner.pid) || !owner.start || readProcStartTime(owner.pid) === owner.start) {
        throw new Error('Discord bridge already running or owner cannot be verified');
      }
      fs.unlinkSync(this.#lock);
    }
    const fd = fs.openSync(this.#lock, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, start: readProcStartTime(process.pid) }));
    } finally {
      fs.closeSync(fd);
    }
    this.#owned = true;
    try {
      const fingerprint = createHash('sha256').update(JSON.stringify(this.#config)).digest('hex');
      if (fs.existsSync(this.#file)) {
        const stateStat = fs.lstatSync(this.#file);
        if (!stateStat.isFile() || (stateStat.mode & 0o777) !== 0o600 || stateStat.uid !== process.getuid?.()) {
          throw new Error('Unsafe Discord journal permissions');
        }
        this.#journal = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
        if (
          this.#journal.v !== 2 ||
          this.#journal.fingerprint !== fingerprint ||
          typeof this.#journal.cursor !== 'string' ||
          !/^([0-9]{1,24})?$/.test(this.#journal.cursor) ||
          typeof this.#journal.paused !== 'boolean' ||
          (this.#journal.stopPending !== undefined && typeof this.#journal.stopPending !== 'boolean') ||
          (this.#journal.retryAt !== undefined &&
            (typeof this.#journal.retryAt !== 'number' || !Number.isFinite(this.#journal.retryAt))) ||
          !Array.isArray(this.#journal.jobs) ||
          !Array.isArray(this.#journal.outbox) ||
          !this.#journal.outbox.every(validOutbox) ||
          Object.keys(this.#journal).some(
            (key) =>
              ![
                'v',
                'fingerprint',
                'cursor',
                'paused',
                'stopPending',
                'retryAt',
                'jobs',
                'outbox',
                'proactive',
              ].includes(key),
          ) ||
          (this.#journal.proactive !== undefined && !Array.isArray(this.#journal.proactive))
        )
          throw stateError(
            'journal_state',
            'Discord journal/config mismatch; archive old state and use a fresh stateDir',
          );
        for (const job of this.#journal.jobs)
          if (!validJob(job))
            throw stateError('journal_state', 'Invalid v2 Discord journal; archive old state and use a fresh stateDir');
        if (this.#journal.stopPending)
          this.#warn('Previous stop outcome uncertain; routing remains paused. Check each terminal before resume.');
        for (const output of this.#journal.outbox)
          if (output.state === 'sending') {
            output.state = 'uncertain';
            this.#warn('Uncertain Discord output retained; reconcile journal, do not resend blindly');
          }
      } else {
        this.#journal = { v: 2, fingerprint, cursor: '', paused: false, jobs: [], outbox: [] };
      }
      this.#journal.proactive ??= [];
      for (const entry of this.#journal.proactive) {
        if (
          !entry ||
          Object.keys(entry).some(
            (key) => !['binding', 'requestId', 'digest', 'alias', 'channelId', 'outputs'].includes(key),
          ) ||
          typeof entry.requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(entry.requestId) ||
          typeof entry.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.digest) ||
          !validBinding(entry.binding) ||
          typeof entry.alias !== 'string' ||
          !isControlSocketName(entry.alias) ||
          entry.channelId !== this.#config.channelId ||
          !Array.isArray(entry.outputs) ||
          !entry.outputs.length ||
          new Set(entry.outputs).size !== entry.outputs.length ||
          entry.outputs.some(
            (id) =>
              !this.#journal.outbox.some(
                (output) =>
                  output.id === id &&
                  typeof output.content === 'string' &&
                  ['queued', 'sending', 'sent', 'uncertain'].includes(output.state),
              ),
          ) ||
          this.#journal.proactive.filter(
            (other) => other.requestId === entry.requestId && sameDiscordBinding(other.binding, entry.binding),
          ).length !== 1
        )
          throw stateError('journal_state', 'Invalid proactive Discord journal; reconciliation required');
      }
      this.#retryAt = this.#journal.retryAt ?? 0;
      this.#save();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Release only this bridge's ownership; pending work and reconciliation records survive. */
  close(): void {
    this.#outbound?.close();
    if (this.#owned) {
      fs.unlinkSync(this.#lock);
      this.#owned = false;
    }
  }

  #save(): void {
    this.#journal.retryAt = this.#retryAt;
    if (this.#failed) throw new Error('Discord persistence unavailable');
    try {
      atomicSave(this.#file, this.#journal);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  /** Advertise only after private durable ownership; credentials never enter the endpoint. */
  async listenOutbound(): Promise<void> {
    if (!this.#owned || this.#failed || this.#outbound) throw new Error('Discord bridge unavailable');
    const server = new DiscordOutboundServer(
      this.#runtimeDir,
      this.#config.stateDir,
      {
        fingerprint: this.#journal.fingerprint,
        channelId: this.#config.channelId,
      },
      (method, params) => this.#send(method, params),
    );
    await server.listen();
    this.#outbound = server;
  }

  // All mutations and saves are synchronous, including RPC admission. Tick never holds a
  // detached journal snapshot across an await; no overlapping load/modify/write can occur.
  #send(method: string, raw: unknown): DiscordSendResult {
    const params = raw as { binding: DiscordBinding; requestId: string; text?: string };
    const reject = (reason: string): DiscordSendResult => ({
      requestId: typeof params?.requestId === 'string' ? params.requestId : '',
      delivery: 'rejected',
      reason,
    });
    const sending = method === 'discord_send';
    if (
      (!sending && method !== 'discord_send_status') ||
      !params ||
      typeof params !== 'object' ||
      Object.keys(params).some(
        (key) => !(sending ? ['binding', 'requestId', 'text'] : ['binding', 'requestId']).includes(key),
      ) ||
      typeof params.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(params.requestId) ||
      !params.binding ||
      Object.keys(params.binding).some((key) => !['socketPath', 'sessionId', 'startedAt'].includes(key)) ||
      (sending && (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 16_384))
    )
      return reject('invalid_input');
    const alias = Object.entries(this.#attached()).find(([, binding]) =>
      sameDiscordBinding(params.binding, binding),
    )?.[0];
    if (!alias) return reject('identity_changed');
    if (!this.#owned || this.#failed) throw new Error('Discord persistence unavailable');
    const records = this.#journal.proactive!;
    const existing = records.find(
      (entry) => entry.requestId === params.requestId && sameDiscordBinding(entry.binding, params.binding),
    );
    // Hash the JSON payload, not Node's lossy UTF-8 conversion of lone UTF-16 surrogates.
    const digest = sending ? createHash('sha256').update(JSON.stringify(params.text)).digest('hex') : '';
    const status = (entry: Proactive): DiscordSendResult => {
      const outputs = entry.outputs.map((id) => this.#journal.outbox.find((output) => output.id === id)!);
      const counts = { queued: 0, sent: 0, uncertain: 0 };
      for (const output of outputs) counts[output.state === 'sending' ? 'queued' : output.state]++;
      return {
        requestId: entry.requestId,
        channelId: entry.channelId,
        senderAlias: entry.alias,
        chunks: counts,
        delivery: counts.uncertain ? 'uncertain' : counts.sent === outputs.length ? 'sent' : 'queued',
      };
    };
    if (existing) return sending && digest !== existing.digest ? reject('request_id_conflict') : status(existing);
    if (!sending) return { requestId: params.requestId, delivery: 'missing' };
    try {
      this.#binding(alias);
    } catch {
      return reject('identity_changed');
    }
    if (this.#journal.paused) return reject('paused');
    // Match the existing work-inbox scale, not an artificial lifetime send count.
    // Retain dedup evidence indefinitely; only new proactive admission is stopped at
    // a 16 MiB serialized journal budget. Ingress/recovery and status remain usable.
    const pending = records.filter((entry) => status(entry).delivery === 'queued').length;
    if (pending >= 128) return { ...reject('capacity'), capacity: { kind: 'pending', used: pending, limit: 128 } };
    const seed =
      'proactive_' +
      createHash('sha256')
        .update(JSON.stringify([params.binding, params.requestId]))
        .digest('hex');
    const before = this.#journal.outbox.length;
    this.#post(seed, `[${alias}] ${params.text!}`);
    const entry: Proactive = {
      binding: { ...params.binding },
      requestId: params.requestId,
      digest,
      alias,
      channelId: this.#config.channelId,
      outputs: this.#journal.outbox.slice(before).map((output) => output.id),
    };
    records.push(entry);
    const bytes = Buffer.byteLength(JSON.stringify(this.#journal));
    if (bytes > 16 * 1024 * 1024) {
      records.pop();
      this.#journal.outbox.splice(before);
      return { ...reject('capacity'), capacity: { kind: 'journal_bytes', used: bytes, limit: 16 * 1024 * 1024 } };
    }
    this.#save(); // index and chunks durable together, before acknowledgement or POST
    return status(entry);
  }

  #post(id: string, text: string): void {
    const pieces = chunks(text);
    const label = /^\[[^\]]{1,64}\]/.exec(text)?.[0] ?? '[bridge]';
    for (const [index, piece] of pieces.entries()) {
      const content = pieces.length > 1 ? `${label} [${index + 1}/${pieces.length}] ${piece}` : piece;
      const key = createHash('sha256').update(`${id}_${index}`).digest('hex').slice(0, 24);
      if (!this.#journal.outbox.some((entry) => entry.id === key))
        this.#journal.outbox.push({ id: key, content, state: 'queued' });
    }
  }

  async #request(method: string, suffix: string, body?: unknown): Promise<Response> {
    try {
      const response = await fetch(`${this.#apiBase}/channels/${this.#config.channelId}/messages${suffix}`, {
        method,
        headers: { Authorization: `Bot ${this.#token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (response.status === 429) {
        const retry = (await response.json()) as { retry_after?: number };
        const seconds =
          typeof retry.retry_after === 'number' && Number.isFinite(retry.retry_after) ? retry.retry_after : 5;
        this.#retryAt = Date.now() + Math.max(1, seconds) * 1000;
      }
      const reset = Number(response.headers.get('x-ratelimit-reset-after'));
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
        this.#retryAt = Math.max(this.#retryAt, Date.now() + reset * 1000);
      }
      return response;
    } catch {
      throw new Error('Discord transport unavailable (credentials and response body redacted)');
    }
  }

  /** Live aliases come only from explicitly opted-in control advertisements; there is no cache. */
  #attached(): Record<string, Binding> {
    const attached = Object.create(null) as Record<string, Binding>;
    for (const ad of listControlAdvertisements(this.#runtimeDir)) {
      if (ad.discordInput !== true) continue;
      attached[ad.name] = { socketPath: ad.socketPath, sessionId: ad.sessionId, startedAt: ad.startedAt };
    }
    return attached;
  }
  #binding(alias: string): Binding {
    const binding = this.#attached()[alias];
    if (!binding) throw new Error('Discord alias is not attached');
    return binding;
  }

  async #ingress(): Promise<void> {
    const response = await this.#request(
      'GET',
      this.#journal.cursor ? `?after=${this.#journal.cursor}&limit=50` : '?limit=1',
    );
    if (!response.ok) throw new Error(`Discord read rejected (HTTP ${response.status})`);
    const messages = (await response.json()) as DiscordMessage[];
    if (
      !Array.isArray(messages) ||
      messages.some(
        (message) =>
          !snowflakePattern.test(message.id) ||
          message.channel_id !== this.#config.channelId ||
          typeof message.content !== 'string' ||
          !message.author?.id,
      )
    ) {
      throw new Error('Invalid Discord channel response');
    }
    if (!this.#journal.cursor) {
      this.#journal.cursor = messages[0]?.id ?? '0';
      this.#post(
        'ready',
        '[bridge] Ready. Only new messages from the configured human are accepted. Use @alias text; !bridge pause/resume/status/stop.',
      );
      this.#save();
      return;
    }
    messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const message of messages) {
      if (BigInt(message.id) <= BigInt(this.#journal.cursor)) continue;
      // Never trust Discord bot identity, including our own echo or webhook messages.
      if (message.author.id === this.#config.humanUserId && !message.author.bot && !message.webhook_id) {
        if (message.content.startsWith('!bridge ')) {
          await this.#command(message);
        } else if (message.content.trim()) {
          const route = /^@([A-Za-z0-9_-]+)(?:\s+|$)([\s\S]*)$/.exec(message.content);
          const alias = route?.[1] ?? this.#config.coordinator;
          const text = route ? route[2]!.trim() : message.content;
          if ((message.content.startsWith('@') && !route) || !text || text.length > 32_000) {
            this.#post(`reject_${message.id}`, '[bridge] Unknown target, empty or oversized message; not delivered.');
          } else if (this.#journal.jobs.filter((job) => !['done', 'uncertain'].includes(job.state)).length >= 128) {
            // Bound work admission, never the shared cursor carrying human recovery controls.
            this.#post(
              `overflow_${message.id}`,
              `[bridge → ${alias}] Work inbox full (128 pending). Message ${message.id} NOT accepted: not queued or sent to a session. Resend after the backlog drains. !bridge status/resume/stop remain available.`,
            );
          } else {
            const binding = this.#attached()[alias];
            if (!binding)
              this.#post(
                `reject_${message.id}`,
                `[bridge] Target ${alias} is not attached; message ${message.id} NOT accepted and not delivered.`,
              );
            else
              this.#journal.jobs.push({
                id: `discord_${message.id}`,
                alias,
                binding,
                text,
                origin: { kind: 'human', sender: this.#config.humanUserId },
                hops: 0,
                state: 'new',
              });
          }
        }
      }
      this.#journal.cursor = message.id;
      this.#save();
    }
  }

  async #command(message: DiscordMessage): Promise<void> {
    const command = message.content.slice('!bridge '.length).trim();
    if (command === 'pause') this.#journal.paused = true;
    else if (command === 'resume') this.#journal.paused = false;
    else if (command === 'stop') {
      this.#journal.paused = true;
      this.#journal.stopPending = true;
      this.#journal.cursor = message.id;
      // Persist the stop before contacting any session; restarting cannot resume chains.
      for (const job of this.#journal.jobs) {
        job.noRoute = true;
        if (job.state === 'new') {
          job.state = 'done';
          job.text = '';
        }
      }
      this.#save();
      let stopped = true;
      for (const alias of Object.keys(this.#attached())) {
        try {
          const binding = this.#binding(alias);
          await callDiscordControl(binding.socketPath, 'interrupt');
        } catch {
          stopped = false;
          this.#warn('Discord stop could not reach an attached session; use terminal Escape');
        }
      }
      this.#journal.stopPending = !stopped;
      this.#save();
    } else if (command !== 'status') {
      this.#post(
        `command_${message.id}`,
        '[bridge] Commands: !bridge pause | resume | status | stop. Stop pauses routing and interrupts attached sessions; approvals stay terminal-owned.',
      );
      return;
    }
    const attached = Object.keys(this.#attached());
    this.#post(
      `command_${message.id}`,
      `[bridge] ${this.#journal.paused ? 'Paused' : 'Running'}; pending ${
        this.#journal.jobs.filter((job) => !['done', 'uncertain'].includes(job.state)).length
      }. ${
        attached.length ? `Attached: ${attached.join(', ')}.` : 'No sessions attached.'
      } Pause prevents new dispatch only. Stop requires explicit resume.`,
    );
  }

  async #jobs(): Promise<void> {
    // Snapshot: a peer reply may create a new job, but it cannot run in this same tick.
    for (const job of [...this.#journal.jobs]) {
      if (job.state === 'done' || job.state === 'uncertain') continue;
      try {
        const binding = job.binding;
        const live = this.#attached()[job.alias];
        if (!live || !sameDiscordBinding(live, binding)) throw new Error('Discord session identity changed');
        const params = { ...binding, clientRequestId: job.id };
        if (job.state === 'new') {
          if (this.#journal.paused) continue;
          job.state = 'dispatching';
          this.#save();
          let receipt: any;
          try {
            receipt = await callDiscordControl(binding.socketPath, 'bridge_submit', {
              ...params,
              text: job.text,
              origin: job.origin,
            });
          } catch (error) {
            // Only the admission mutation may settle a job as denied. A rejected read-only
            // result query below keeps the retained/uncertain recovery path instead.
            if ((error as { code?: string }).code) {
              job.state = 'done';
              this.#post(
                `${job.id}_denied`,
                `[bridge → ${job.alias}] Control rejected admission; check session opt-in. Original input retained in journal, not retried.`,
              );
              this.#save();
              continue;
            }
            throw error;
          }
          if (!['started', 'queued', 'steering'].includes(receipt.delivery)) {
            job.state = 'done';
            this.#post(
              `${job.id}_rejected`,
              `[bridge → ${job.alias}] Not accepted (${
                receipt.reason ?? 'rejected'
              }); original input retained in journal. Use the terminal for approval/confirmation.`,
            );
          } else {
            job.state = 'accepted';
          }
          this.#save();
        }
        if (job.state !== 'accepted' && job.state !== 'dispatching') continue;
        const result = await callDiscordControl(binding.socketPath, 'bridge_result', params);
        if (result.state === 'missing') {
          job.state = 'uncertain';
          this.#post(
            `${job.id}_missing`,
            `[bridge → ${job.alias}] Result no longer available. Input retained; check terminal history before manual recovery. NOT resubmitted.`,
          );
          this.#save();
          continue;
        }
        if (result.state === 'pending') {
          if (result.receipt) job.state = 'accepted';
          this.#save();
          continue;
        }
        if (result.state === 'final') {
          const text = typeof result.text === 'string' ? result.text : '';
          if (text.trim()) this.#post(`${job.id}_final`, `[${job.alias}] ${text}`);
          const route = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(text);
          if (route && !job.noRoute && !result.truncated) {
            const alias = route[1]!;
            if (!this.#attached()[alias])
              this.#post(`${job.id}_target`, `[bridge] Unknown agent target ${alias}; not delivered.`);
            else if (job.hops >= this.#config.maxHops)
              this.#post(`${job.id}_limit`, '[bridge] Peer hop limit reached; waiting for the human.');
            else
              this.#journal.jobs.push({
                id: `${job.id}_p`,
                alias,
                binding: this.#binding(alias),
                text: route[2]!,
                origin: { kind: 'agent', sender: job.alias },
                hops: job.hops + 1,
                state: 'new',
              });
          }
        } else
          this.#post(`${job.id}_outcome`, `[${job.alias}] ${result.state}; inspect the terminal. No peer activation.`);
        job.state = 'done';
        job.text = '';
        this.#save();
      } catch {
        // A coded failure here came from the read-only result query; the admission mutation
        // classifies its own rejection above, so a dispatching row is never settled as denied.
        // If the session was temporarily unavailable after a dispatch, read-only recovery
        // on the next tick is safe; never send a second mutation automatically.
        if (job.state === 'new') {
          this.#post(
            `${job.id}_waiting`,
            `[bridge → ${job.alias}] Target is not attached right now. Input retained and NOT delivered; only the exact admitted process identity may receive it. Reconcile in the terminal otherwise.`,
          );
          this.#save();
          continue;
        }
        const live = this.#attached()[job.alias];
        if (!live || !sameDiscordBinding(live, job.binding)) {
          job.state = 'uncertain';
          this.#post(
            `${job.id}_uncertain`,
            `[bridge → ${job.alias}] Session identity changed or disconnected. Input retained for reconciliation; NOT resubmitted. Reconcile after checking terminal history.`,
          );
          this.#save();
          continue;
        }
        this.#warn('Control unavailable or outcome unknown; retaining input without resubmission');
      }
    }
  }

  async #outputs(): Promise<void> {
    for (const outgoing of this.#journal.outbox) {
      if (Date.now() < this.#retryAt) return;
      if (outgoing.state !== 'queued') continue;
      outgoing.state = 'sending';
      this.#save();
      try {
        const response = await this.#request('POST', '', {
          content: outgoing.content,
          allowed_mentions: { parse: [], replied_user: false },
          nonce: outgoing.id,
          enforce_nonce: true,
        });
        if (response.status === 429) {
          outgoing.state = 'queued';
          this.#save();
          return;
        }
        // Non-2xx may hide a successful effect at an intermediary. Never blindly resend.
        if (!response.ok) throw new Error('Discord output not acknowledged');
        outgoing.state = 'sent';
        this.#save();
      } catch {
        outgoing.state = 'uncertain';
        this.#save();
        this.#warn('Uncertain Discord output retained in journal; do not resend without reconciliation');
      }
      // At most one Discord POST per normal one-second cycle, including failures.
      return;
    }
  }

  /** Perform one bounded poll/admission/result/outbox cycle; call serially after open(). */
  async tick(): Promise<void> {
    if (!this.#owned || this.#failed || this.#running) throw new Error('Discord bridge not open or already ticking');
    if (Date.now() < this.#retryAt) return;
    this.#running = true;
    try {
      try {
        await this.#ingress();
        this.#readFailures = 0;
      } catch {
        this.#readFailures++;
        this.#retryAt = Math.max(
          this.#retryAt,
          Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(6, this.#readFailures)),
        );
        this.#warn('Discord ingress unavailable or rejected; cursor retained, bounded backoff active');
      }
      await this.#jobs();
      if (Date.now() >= this.#retryAt) await this.#outputs();
      // Keep pending/uncertain evidence; trim only settled records behind the persisted cursor.
      const done = this.#journal.jobs.filter((job) => job.state === 'done');
      const retained = new Set(this.#journal.proactive!.flatMap((entry) => entry.outputs));
      const sent = this.#journal.outbox.filter((output) => output.state === 'sent' && !retained.has(output.id));
      if (done.length > 256)
        this.#journal.jobs = this.#journal.jobs.filter(
          (job) => job.state !== 'done' || done.indexOf(job) >= done.length - 256,
        );
      if (sent.length > 512)
        this.#journal.outbox = this.#journal.outbox.filter(
          (output) => retained.has(output.id) || output.state !== 'sent' || sent.indexOf(output) >= sent.length - 512,
        );
      this.#save();
    } finally {
      this.#running = false;
    }
  }
}
