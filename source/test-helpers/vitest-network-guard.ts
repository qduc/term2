const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input.toString());
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url && !isLoopbackUrl(url)) {
    throw new Error(`External network access is disabled in tests: ${url.origin}`);
  }
  return originalFetch(input, init);
};
