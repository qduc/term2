import WebSocket from 'ws';

/**
 * Discord Gateway "doorbell" for the REST bridge.
 *
 * The Gateway is used only as a low-latency wake-up signal: when the configured human
 * posts in the configured channel, `onNudge` fires and the bridge runs its normal
 * cursor-based REST read. Message content is never taken from the Gateway, so the
 * REST cursor and journal remain the single source of truth and a dropped or duplicated
 * Gateway event can at worst cause one extra or one delayed (fallback-poll) read.
 *
 * Only the non-privileged GUILD_MESSAGES intent is requested; channel and author IDs
 * are enough for a nudge. Credentials and payloads are never included in warnings.
 */

const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const GUILD_MESSAGES = 1 << 9;
/** Close codes after which reconnecting cannot help; the bridge stays on REST polling. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes that invalidate the session, so the next connection must IDENTIFY. */
const RESET_SESSION_CLOSE = new Set([4007, 4009]);

type GatewayPayload = { op: number; d?: any; s?: number | null; t?: string | null };

export type DiscordGatewayOptions = {
  token: string;
  channelId: string;
  humanUserId: string;
  /** Called on a relevant message and after every (re)connect so the bridge can catch up. */
  onNudge: () => void;
  /** Called when push becomes available or unavailable. */
  onLiveChange?: (live: boolean) => void;
  warn?: (message: string) => void;
  /** Test-only loopback endpoint; production always uses the fixed Discord Gateway. */
  url?: string;
};

function validateEndpoint(url: string): URL {
  const parsed = new URL(url);
  if (url === DEFAULT_GATEWAY) return parsed;
  if (parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname)) return parsed;
  throw new Error('Invalid Discord Gateway endpoint');
}

export class DiscordGatewayNudge {
  readonly #options: DiscordGatewayOptions;
  readonly #endpoint: URL;
  readonly #warn: (message: string) => void;
  #socket?: WebSocket;
  #heartbeat?: NodeJS.Timeout;
  #reconnectTimer?: NodeJS.Timeout;
  #acked = true;
  #seq: number | null = null;
  #sessionId?: string;
  #resumeUrl?: string;
  #attempts = 0;
  #live = false;
  #stopped = true;

  constructor(options: DiscordGatewayOptions) {
    if (!options.token || /[\s\r\n]/.test(options.token)) throw new Error('Discord bot token missing or invalid');
    this.#options = options;
    this.#endpoint = validateEndpoint(options.url ?? DEFAULT_GATEWAY);
    this.#warn = options.warn ?? (() => {});
  }

  get live(): boolean {
    return this.#live;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#teardown(1000);
    this.#setLive(false);
  }

  #setLive(live: boolean): void {
    if (this.#live === live) return;
    this.#live = live;
    this.#options.onLiveChange?.(live);
  }

  /** Resume only against the same pinned host family Discord itself hands out. */
  #resumeEndpoint(): URL {
    if (!this.#resumeUrl) return this.#endpoint;
    try {
      const candidate = new URL(this.#resumeUrl);
      const sameOrigin = candidate.protocol === this.#endpoint.protocol && candidate.host === this.#endpoint.host;
      const discordHost = candidate.protocol === 'wss:' && /(^|\.)discord\.gg$/.test(candidate.hostname);
      if (!sameOrigin && !discordHost) return this.#endpoint;
      candidate.search = '?v=10&encoding=json';
      return candidate;
    } catch {
      return this.#endpoint;
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    const resuming = !!this.#sessionId;
    const url = resuming ? this.#resumeEndpoint() : this.#endpoint;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10_000 });
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.on('message', (data) => {
      if (this.#socket !== socket) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(data.toString()) as GatewayPayload;
      } catch {
        return;
      }
      this.#handle(socket, payload);
    });
    socket.on('close', (code) => {
      if (this.#socket !== socket) return;
      this.#onClose(code);
    });
    // Errors are always followed by 'close'; keep their text (which may echo URLs) out of logs.
    socket.on('error', () => {});
  }

  #send(socket: WebSocket, payload: GatewayPayload): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  #handle(socket: WebSocket, payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.#seq = payload.s;
    switch (payload.op) {
      case 10: {
        // HELLO: start heartbeating with the first beat jittered, then IDENTIFY or RESUME.
        const interval = Number(payload.d?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 1000) {
          socket.close(4000);
          return;
        }
        this.#acked = true;
        clearInterval(this.#heartbeat);
        const beat = () => {
          if (!this.#acked) {
            // Zombied connection: no ACK since the last beat. Reconnect and resume.
            socket.close(4000);
            return;
          }
          this.#acked = false;
          this.#send(socket, { op: 1, d: this.#seq });
        };
        this.#heartbeat = setTimeout(() => {
          beat();
          this.#heartbeat = setInterval(beat, interval);
        }, Math.floor(interval * Math.random()));
        if (this.#sessionId) {
          this.#send(socket, {
            op: 6,
            d: { token: this.#options.token, session_id: this.#sessionId, seq: this.#seq },
          });
        } else {
          this.#send(socket, {
            op: 2,
            d: {
              token: this.#options.token,
              intents: GUILD_MESSAGES,
              properties: { os: process.platform, browser: 'term2', device: 'term2' },
            },
          });
        }
        return;
      }
      case 11:
        this.#acked = true;
        return;
      case 1:
        this.#send(socket, { op: 1, d: this.#seq });
        return;
      case 7:
        // Server asked us to reconnect; the session stays resumable.
        socket.close(4000);
        return;
      case 9:
        // Invalid session: d=true means resumable, otherwise start fresh.
        if (payload.d !== true) {
          this.#sessionId = undefined;
          this.#resumeUrl = undefined;
          this.#seq = null;
        }
        socket.close(4000);
        return;
      case 0:
        this.#dispatch(payload);
        return;
      default:
        return;
    }
  }

  #dispatch(payload: GatewayPayload): void {
    const d = payload.d;
    if (payload.t === 'READY' || payload.t === 'RESUMED') {
      if (payload.t === 'READY') {
        this.#sessionId = typeof d?.session_id === 'string' ? d.session_id : undefined;
        this.#resumeUrl = typeof d?.resume_gateway_url === 'string' ? d.resume_gateway_url : undefined;
      }
      this.#attempts = 0;
      this.#setLive(true);
      // Anything posted while disconnected is picked up by the REST cursor.
      this.#options.onNudge();
      return;
    }
    if (
      payload.t === 'MESSAGE_CREATE' &&
      d?.channel_id === this.#options.channelId &&
      d?.author?.id === this.#options.humanUserId &&
      !d?.author?.bot &&
      !d?.webhook_id
    ) {
      this.#options.onNudge();
    }
  }

  #teardown(code: number): void {
    clearTimeout(this.#heartbeat);
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(code);
      } catch {
        socket.terminate();
      }
    }
  }

  #onClose(code: number): void {
    this.#teardown(1000);
    this.#setLive(false);
    if (this.#stopped) return;
    if (FATAL_CLOSE.has(code)) {
      this.#stopped = true;
      this.#warn(
        code === 4004
          ? '[gateway] Authentication rejected; push disabled, continuing with REST polling'
          : `[gateway] Closed with non-recoverable code ${code}; push disabled, continuing with REST polling`,
      );
      return;
    }
    if (RESET_SESSION_CLOSE.has(code)) {
      this.#sessionId = undefined;
      this.#resumeUrl = undefined;
      this.#seq = null;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#attempts++;
    if (this.#attempts === 3) this.#warn('[gateway] Reconnecting; REST polling covers the gap');
    const base = Math.min(60_000, 1000 * 2 ** Math.min(6, this.#attempts - 1));
    const delay = Math.floor(base / 2 + Math.random() * (base / 2));
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }
}
