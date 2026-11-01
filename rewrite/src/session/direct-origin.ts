/** Native origin decoding and immutable admission fingerprinting, not authentication. */
import type { DirectOrigin } from './facade-types.js';

/** Reject unknown identity fields rather than silently dropping durable authority. */
export function parseDirectOrigin(raw: unknown): DirectOrigin {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid direct origin');
  const value = raw as Record<string, unknown>;
  const identifier = (key: string, optional = false): string | undefined => {
    const field = value[key];
    if (optional && field === undefined) return undefined;
    if (typeof field !== 'string' || !field.trim()) throw new Error(`Invalid origin ${key}`);
    return field;
  };
  const kind = value.kind;
  const allowed =
    kind === 'discord'
      ? ['kind', 'source', 'sender', 'discordMessageId', 'relayedBy']
      : kind === 'control'
      ? ['kind', 'id', 'source']
      : ['kind', 'id'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unknown direct origin field');
  if (kind === 'discord') {
    if (!['human', 'agent', 'reaction'].includes(String(value.source))) throw new Error('Invalid Discord source');
    return {
      kind,
      source: value.source as 'human' | 'agent' | 'reaction',
      sender: identifier('sender')!,
      ...(value.discordMessageId === undefined ? {} : { discordMessageId: identifier('discordMessageId')! }),
      ...(value.relayedBy === undefined ? {} : { relayedBy: identifier('relayedBy')! }),
    };
  }
  if (kind === 'control') {
    if (value.source !== undefined && value.source !== 'orchestrator') throw new Error('Invalid control source');
    return {
      kind,
      ...(value.id === undefined ? {} : { id: identifier('id')! }),
      ...(value.source ? { source: 'orchestrator' } : {}),
    };
  }
  if (kind === 'cli' || kind === 'tui' || kind === 'acp' || kind === 'api')
    return { kind, ...(value.id === undefined ? {} : { id: identifier('id')! }) };
  throw new Error('Invalid direct origin kind');
}

/** Stable complete identity, independent of property insertion order or queue edits. */
export function directOriginKey(origin?: DirectOrigin): readonly unknown[] | null {
  if (!origin) return null;
  const value = parseDirectOrigin(origin);
  if (value.kind === 'discord')
    return [value.kind, value.source, value.sender, value.discordMessageId ?? null, value.relayedBy ?? null];
  return [value.kind, value.id ?? null, value.kind === 'control' ? value.source ?? null : null];
}

/** Automatic control/agent/reaction input never opens a fresh human decision window. */
export function isDirectHumanOrigin(origin?: DirectOrigin): boolean {
  return !origin || (origin.kind === 'discord' ? origin.source === 'human' : origin.kind !== 'control');
}
