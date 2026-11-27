/**
 * Shared serialized global mutation lanes (`settings` and `oauth`) and
 * reactive `settings.subscribe` fanout shared across HTTP+SSE and Unix NDJSON.
 */
import type { SettingsProjection } from '../server-contracts.js';

export type SettingsStateUpdate = {
  readonly revision: string;
  readonly settings: Record<string, unknown>;
};

export type SettingsSubscriber = (update: SettingsStateUpdate) => void;

export class GlobalMutationCoordinator {
  #settingsLane: Promise<unknown> = Promise.resolve();
  #oauthLane: Promise<unknown> = Promise.resolve();
  readonly #subscribers = new Set<SettingsSubscriber>();

  runSettings<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#settingsLane.then(operation, operation);
    this.#settingsLane = result.catch(() => undefined);
    return result;
  }

  runOAuth<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#oauthLane.then(operation, operation);
    this.#oauthLane = result.catch(() => undefined);
    return result;
  }

  publishSettings(projection: SettingsProjection): void {
    const update: SettingsStateUpdate = {
      revision: projection.revision,
      settings: { ...projection },
    };
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(update);
      } catch {
        // Subscriber errors must never block other listeners or fail a committed write.
      }
    }
  }

  subscribeSettings(listener: SettingsSubscriber): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }
}
