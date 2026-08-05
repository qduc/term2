import { randomUUID } from 'node:crypto';
import type { Term2HookEvent, Term2HookEventName, Term2HookEventMap, Term2HookScope } from './hook-contracts.js';

export type HookEventFactoryOptions = {
  readonly sessionId: string;
  readonly scope?: Term2HookScope;
  readonly includeUserText?: boolean;
  readonly includeToolArguments?: boolean;
  readonly includeToolResults?: boolean;
};

/** Builds the versioned envelope without exposing provider/runtime IDs. */
export class HookEventFactory {
  readonly #options: HookEventFactoryOptions;

  constructor(options: HookEventFactoryOptions) {
    this.#options = options;
  }

  create<Name extends Term2HookEventName>(
    type: Name,
    payload: Omit<Term2HookEventMap[Name], 'type' | 'schemaVersion' | 'eventId' | 'sessionId' | 'timestamp' | 'scope'>,
    correlation: Pick<Term2HookEvent<Name>, 'turnId' | 'toolCallId'> = {},
    scope: Term2HookScope = this.#options.scope ?? 'root',
  ): Term2HookEvent<Name> {
    return {
      type,
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId: this.#options.sessionId,
      timestamp: Date.now(),
      scope,
      ...correlation,
      ...payload,
    } as Term2HookEvent<Name>;
  }

  get includeUserText(): boolean {
    return this.#options.includeUserText === true;
  }

  get includeToolArguments(): boolean {
    return this.#options.includeToolArguments === true;
  }

  get includeToolResults(): boolean {
    return this.#options.includeToolResults === true;
  }
}

export function summarizeHookValue(value: unknown, maxLength = 500): unknown {
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxLength) return value;
    return `${text.slice(0, maxLength)}...`;
  } catch {
    return '[unserializable]';
  }
}
