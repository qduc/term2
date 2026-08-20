import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSettingsDirectory } from '../services/settings/settings-path.js';
import type { OpencodeModelTransport } from './opencode-routing.js';

const DOCUMENTATION_URL = 'https://opencode.ai/docs/zen.md';
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DOCUMENTATION_LOOKUP_TIMEOUT_MS = 2_000;
const TRANSPORTS = new Set<OpencodeModelTransport>([
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
]);

type TransportMap = Record<string, OpencodeModelTransport>;

type CachedTransportMap = {
  version: number;
  fetchedAt: number;
  transports: TransportMap;
};

export type OpencodeTransportDiscovery = {
  resolve(modelId: string, signal?: AbortSignal): Promise<OpencodeModelTransport | undefined>;
};

export class CachedOpencodeTransportDiscovery implements OpencodeTransportDiscovery {
  readonly #cachePath: string;
  readonly #fetchImpl: typeof fetch;
  readonly #documentationUrl: string;
  readonly #now: () => number;

  constructor(
    options: {
      cachePath?: string;
      fetchImpl?: typeof fetch;
      documentationUrl?: string;
      now?: () => number;
    } = {},
  ) {
    this.#cachePath = options.cachePath ?? path.join(resolveSettingsDirectory(), 'opencode-transport-cache.json');
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#documentationUrl = options.documentationUrl ?? DOCUMENTATION_URL;
    this.#now = options.now ?? Date.now;
  }

  async resolve(modelId: string, signal?: AbortSignal): Promise<OpencodeModelTransport | undefined> {
    const normalizedModelId = modelId.trim().toLowerCase();
    if (!normalizedModelId) return undefined;

    const cached = await this.#readCache();
    if (cached && this.#isFresh(cached)) return cached.transports[normalizedModelId];

    const refreshed = await this.#refresh(signal);
    return refreshed?.[normalizedModelId];
  }

  async #readCache(): Promise<CachedTransportMap | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.#cachePath, 'utf8'));
      if (
        raw?.version !== CACHE_VERSION ||
        !Number.isFinite(raw?.fetchedAt) ||
        raw.fetchedAt > this.#now() ||
        !isTransportMap(raw?.transports)
      ) {
        return undefined;
      }
      return raw as CachedTransportMap;
    } catch {
      return undefined;
    }
  }

  #isFresh(cache: CachedTransportMap): boolean {
    return this.#now() - cache.fetchedAt <= CACHE_MAX_AGE_MS;
  }

  async #refresh(signal?: AbortSignal): Promise<TransportMap | undefined> {
    try {
      const lookupSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(DOCUMENTATION_LOOKUP_TIMEOUT_MS)])
        : AbortSignal.timeout(DOCUMENTATION_LOOKUP_TIMEOUT_MS);
      const response = await this.#fetchImpl(this.#documentationUrl, {
        headers: { Accept: 'text/markdown' },
        signal: lookupSignal,
      });
      if (!response.ok) return undefined;

      const transports = parseOpencodeTransportDocumentation(await response.text());
      if (Object.keys(transports).length === 0) return undefined;

      const cache = { version: CACHE_VERSION, fetchedAt: this.#now(), transports };
      await this.#writeCache(cache);
      return transports;
    } catch {
      return undefined;
    }
  }

  async #writeCache(cache: CachedTransportMap): Promise<void> {
    const directory = path.dirname(this.#cachePath);
    const temporaryPath = `${this.#cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(temporaryPath, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.#cachePath);
    } catch {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function parseOpencodeTransportDocumentation(documentation: string): TransportMap {
  const transports: TransportMap = {};
  for (const line of documentation.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const modelId = cells[2];
    const endpoint = cells[3]?.replaceAll('`', '');
    const transport = transportForEndpoint(endpoint);
    if (modelId && transport) transports[modelId.toLowerCase()] = transport;
  }
  return transports;
}

function transportForEndpoint(endpoint: string | undefined): OpencodeModelTransport | undefined {
  if (endpoint?.endsWith('/responses')) return 'openai-responses';
  if (endpoint?.endsWith('/messages')) return 'anthropic-messages';
  if (endpoint?.endsWith('/chat/completions')) return 'openai-chat-completions';
  return undefined;
}

function isTransportMap(value: unknown): value is TransportMap {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).every(
      ([modelId, transport]) =>
        modelId.length > 0 && typeof transport === 'string' && TRANSPORTS.has(transport as OpencodeModelTransport),
    )
  );
}
