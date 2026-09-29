import { RequestValidationError } from './request-validation';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function hostnameFromHostHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function assertLocalHostname(value: string | null, label: string): void {
  if (!LOCAL_HOSTNAMES.has(hostnameFromHostHeader(value) ?? '')) {
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
      assertLocalHostname(new URL(origin).host, 'origin');
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
