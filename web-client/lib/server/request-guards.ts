import { RequestValidationError } from './request-validation';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const ALLOWED_HOSTS_ENV = 'TERM2_WEB_CLIENT_ALLOWED_HOSTS';

function allowedHostnames(): Set<string> {
  const names = new Set(LOCAL_HOSTNAMES);
  // TERM2_WEB_CLIENT_ALLOWED_HOSTS is an explicit comma-separated hostname allowlist for LAN access.
  for (const raw of (process.env[ALLOWED_HOSTS_ENV] ?? '').split(',')) {
    const value = raw.trim();
    if (!value || /[\\/@?#]/u.test(value)) continue;
    try {
      const hostname = new URL(`http://${value}`).hostname.toLowerCase();
      if (hostname) names.add(hostname);
    } catch {
      // Ignore malformed opt-in entries; an empty or invalid setting grants no additional hosts.
    }
  }
  return names;
}

function hostnameFromHostHeader(value: string | null): string | null {
  if (!value || /[\\/@?#]/u.test(value)) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function assertLocalHostname(value: string | null, label: string): void {
  if (!allowedHostnames().has(hostnameFromHostHeader(value) ?? '')) {
    throw new RequestValidationError(`Invalid ${label}`);
  }
}

export function assertLocalStateChangingRequest(request: Request): void {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new RequestValidationError('Content-Type must be application/json');
  assertLocalHostname(request.headers.get('host'), 'host');
  const origin = request.headers.get('origin');
  if (origin !== null) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.username || parsedOrigin.password) throw new RequestValidationError('Invalid origin');
      assertLocalHostname(parsedOrigin.host, 'origin');
    } catch (error) {
      if (error instanceof RequestValidationError) throw error;
      throw new RequestValidationError('Invalid origin');
    }
  }
}

export function attachAbortCleanup(signal: AbortSignal, destroy: () => void): void {
  if (signal.aborted) {
    destroy();
    return;
  }
  signal.addEventListener('abort', destroy, { once: true });
}
