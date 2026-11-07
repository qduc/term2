import { isIP } from 'node:net';

/** Mirrors sandbox-runtime 0.0.56 parent-proxy isValidHost and stripBrackets. */
export function isSandboxNetworkHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 255) return false;
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return !bare.includes('%') && (isIP(bare) !== 0 || /^[A-Za-z0-9._-]+$/.test(bare));
}

export function isSandboxNetworkPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}
