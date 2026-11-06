import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Preserve interactive IDs; namespace legacy headless IDs without conflating their UUIDs. */
export function nativeIdForSource(id) {
  if (typeof id !== 'string') return undefined;
  if (UUID.test(id)) return `conv_${id}`;
  const prefix = 'non-interactive-';
  if (!id.startsWith(prefix) || !UUID.test(id.slice(prefix.length))) return undefined;
  const bytes = createHash('sha256').update(`term2:v3-headless:v1\0${id}`).digest().subarray(0, 16);
  // UUIDv8 carries an application-defined deterministic mapping, not a random ID.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `conv_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
