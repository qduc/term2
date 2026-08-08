import type { NetworkApprovalAnswer, SandboxNetworkAccessRequest } from './sandbox-network-approval.js';

export type SandboxNetworkApprovalSnapshot = Readonly<{
  activeRequest: SandboxNetworkAccessRequest | null;
}>;

type PendingRequest = {
  request: SandboxNetworkAccessRequest;
  resolve: (answer: NetworkApprovalAnswer) => void;
};

/**
 * Serializes sandbox-network approval requests for one interactive surface.
 *
 * The coordinator owns the request lifetime: one request is observable at a
 * time, and teardown fails closed for both the active request and every queued
 * request. Its consumer only needs to render `activeRequest` and submit an
 * answer for it.
 */
export class SandboxNetworkApprovalCoordinator {
  #active: PendingRequest | null = null;
  #queue: PendingRequest[] = [];
  #listeners = new Set<() => void>();
  #snapshot: SandboxNetworkApprovalSnapshot = { activeRequest: null };
  #disposed = false;

  getSnapshot(): SandboxNetworkApprovalSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(request: SandboxNetworkAccessRequest): Promise<NetworkApprovalAnswer> {
    if (this.#disposed) return Promise.resolve('deny');

    return new Promise<NetworkApprovalAnswer>((resolve) => {
      this.#queue.push({ request, resolve });
      this.#showNext();
    });
  }

  resolve(request: SandboxNetworkAccessRequest, answer: NetworkApprovalAnswer): void {
    const active = this.#active;
    if (!active || active.request !== request || this.#disposed) return;

    this.#active = null;
    this.#showNext();
    active.resolve(answer);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    const pending = [...(this.#active ? [this.#active] : []), ...this.#queue];
    this.#active = null;
    this.#queue = [];
    this.#setSnapshot(null);
    for (const item of pending) item.resolve('deny');
  }

  #showNext(): void {
    if (this.#active || this.#disposed) return;
    const next = this.#queue.shift() ?? null;
    this.#active = next;
    this.#setSnapshot(next?.request ?? null);
  }

  #setSnapshot(activeRequest: SandboxNetworkAccessRequest | null): void {
    if (this.#snapshot.activeRequest === activeRequest) return;
    this.#snapshot = { activeRequest };
    for (const listener of this.#listeners) listener();
  }
}
