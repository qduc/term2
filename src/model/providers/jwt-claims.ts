/**
 * Best-effort JWT payload decoding for credential bookkeeping.
 *
 * These tokens arrive over TLS from the issuer we just authenticated against,
 * and nothing security-bearing is decided from the claims — they name and date
 * a credential we already hold. So the payload is read without verifying the
 * signature, and every malformed input is simply "no claims".
 */
export function getJwtClaims(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Expiry in epoch milliseconds, or null when the token does not state one. */
export function getJwtExpiry(token: string): number | null {
  const payload = getJwtClaims(token);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}
