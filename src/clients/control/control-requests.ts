/** Control RPC compatibility and transport replay, not domain admission authority.
 * Fingerprints distinguish method/origin/session; actual durable dedupe remains Session-owned.
 */
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  CONTROL_TOPICS,
  ControlIdempotencyMap,
  type ControlErrorCode,
  type ControlMutationReceipt,
  type BridgeOutcome,
} from '../control-socket/control-socket.js';
import type { ControlSessionPort } from './control-transport-types.js';
import { ControlMutationUnavailable } from './control-transport-files.js';

interface RequestContext {
  port(): ControlSessionPort | null;
  sessionId(): string;
  startedAt(): string;
  readonly discordInput: boolean;
  runMutation<T>(operation: () => T | Promise<T>): Promise<T>;
  interruptHandler():
    | (() => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string })
    | null;
}
function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body) ?? 'undefined')
    .digest('hex');
}
/** Preserve the existing v1 result bound for live and recovered answers alike. */
function boundedOutcome(outcome: BridgeOutcome): BridgeOutcome {
  return {
    ...outcome,
    truncated: (outcome.text?.length ?? 0) > 16_384,
    ...(outcome.text !== undefined
      ? {
          text:
            outcome.text.slice(0, 16_384) + (outcome.text.length > 16_384 ? '\n[truncated by session control]' : ''),
        }
      : {}),
  };
}
function error(code: ControlErrorCode, message: string): { code: ControlErrorCode; message: string } {
  return { code, message };
}

function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(value)}\n`);
}

/** One instance per socket server; no request body or observer enters a domain fact. */
export class ControlRequests {
  readonly #context: RequestContext;
  readonly #idempotency = new ControlIdempotencyMap<ControlMutationReceipt>();
  readonly #bridgeResults = new Map<
    string,
    { body: string; receipt?: ControlMutationReceipt; outcome: BridgeOutcome }
  >();
  constructor(context: RequestContext) {
    this.#context = context;
  }
  async dispatch(socket: Socket, request: any, helloSeen: boolean, inFlight: Set<string>): Promise<boolean> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const reply = (ok: boolean, result?: unknown, code?: ControlErrorCode, message?: string) =>
      send(socket, {
        v: 1,
        id,
        ok,
        ...(ok ? { result } : { error: error(code ?? 'internal', message ?? 'Request failed') }),
      });
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.id !== 'string' ||
      !request.id ||
      typeof request.method !== 'string'
    ) {
      reply(false, undefined, 'invalid_request', 'Expected request with id and method');
      return helloSeen;
    }
    if (request.v !== 1) {
      reply(false, undefined, 'unsupported_version', 'Only protocol version 1 is supported');
      socket.end();
      return helloSeen;
    }
    if (inFlight.has(id)) {
      reply(false, undefined, 'invalid_request', 'Request id is already in flight');
      return helloSeen;
    }
    inFlight.add(id);
    try {
      if (!helloSeen && request.method !== 'hello') {
        reply(false, undefined, 'unauthorized', 'hello must be the first request');
        socket.end();
        return helloSeen;
      }
      if (request.method === 'hello') {
        if (helloSeen) {
          reply(false, undefined, 'invalid_request', 'hello may only be sent once');
          return helloSeen;
        }
        reply(true, { v: 1, capabilities: ['submit', 'steer', 'interrupt'], topics: [...CONTROL_TOPICS] });
        return true;
      }
      if (
        !['status', 'get', 'submit', 'steer', 'interrupt', 'bridge_submit', 'bridge_result'].includes(request.method)
      ) {
        reply(false, undefined, 'unknown_method', `Unknown method: ${request.method}`);
        return helloSeen;
      }
      const port = this.#context.port();
      if (!port) {
        reply(false, undefined, 'not_ready', 'Interactive session is not ready');
        return helloSeen;
      }
      if (request.method === 'bridge_submit' || request.method === 'bridge_result') {
        const params = request.params;
        if (!this.#context.discordInput || !port.bridgeSubmit) {
          reply(false, undefined, 'unauthorized', 'Session has not opted in to Discord input');
          return helloSeen;
        }
        if (
          !params ||
          params.sessionId !== this.#context.sessionId() ||
          params.startedAt !== this.#context.startedAt()
        ) {
          reply(false, undefined, 'conflict', 'Session identity changed; remap explicitly');
          return helloSeen;
        }
        const requestId = params.clientRequestId;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(requestId)) {
          reply(false, undefined, 'invalid_request', 'Invalid bridge request id');
          return helloSeen;
        }
        const key = JSON.stringify([params.sessionId, requestId]);
        if (request.method === 'bridge_result') {
          const entry = this.#bridgeResults.get(key);
          const recovered = await port.bridgeResult?.({ sessionId: params.sessionId, clientRequestId: requestId });
          reply(
            true,
            recovered && recovered.state !== 'missing'
              ? { ...boundedOutcome(recovered), receipt: recovered.receipt }
              : entry
              ? { ...entry.outcome, receipt: entry.receipt }
              : { state: 'missing' },
          );
          return helloSeen;
        }
        if (
          typeof params.text !== 'string' ||
          !params.text.trim() ||
          params.text.length > 32_000 ||
          !params.origin ||
          typeof params.origin !== 'object' ||
          Array.isArray(params.origin) ||
          !['human', 'agent', 'reaction'].includes(params.origin.kind) ||
          typeof params.origin.sender !== 'string' ||
          (params.origin.kind === 'human'
            ? !/^[0-9]{1,24}$/.test(params.origin.sender) ||
              (params.origin.discordMessageId !== undefined &&
                (typeof params.origin.discordMessageId !== 'string' ||
                  !/^[0-9]{1,24}$/.test(params.origin.discordMessageId))) ||
              (params.origin.relayedBy !== undefined &&
                (typeof params.origin.relayedBy !== 'string' ||
                  !/^[A-Za-z0-9_-]{1,64}$/.test(params.origin.relayedBy))) ||
              (params.origin.relayedBy !== undefined && !params.origin.discordMessageId) ||
              Object.keys(params.origin).some(
                (key) => !['kind', 'sender', 'discordMessageId', 'relayedBy'].includes(key),
              )
            : !(params.origin.kind === 'reaction' ? /^[0-9]{1,24}$/ : /^[A-Za-z0-9_-]{1,64}$/).test(
                params.origin.sender,
              ) || Object.keys(params.origin).some((key) => !['kind', 'sender'].includes(key)))
        ) {
          reply(false, undefined, 'invalid_request', 'Invalid bridge input');
          return helloSeen;
        }
        const body = hashBody({
          sessionId: params.sessionId,
          delivery: params.origin.kind === 'human' ? 'steer' : 'follow_up',
          text: params.text,
          origin: {
            kind: params.origin.kind,
            sender: params.origin.sender,
            discordMessageId: params.origin.discordMessageId ?? null,
            relayedBy: params.origin.relayedBy ?? null,
          },
        });
        const result = await this.#context.runMutation(async () => {
          if (port !== this.#context.port() || params.sessionId !== this.#context.sessionId())
            throw new ControlMutationUnavailable('Session binding changed; remap explicitly.');
          const prior = this.#bridgeResults.get(key);
          if (prior) return prior.body === body ? { ...prior.receipt, replayed: true } : null;
          if (this.#bridgeResults.size >= 256) {
            const completed = [...this.#bridgeResults].find(([, entry]) => entry.outcome.state !== 'pending');
            if (!completed) return { delivery: 'rejected', reason: 'bridge_capacity' };
            this.#bridgeResults.delete(completed[0]);
          }
          const entry: { body: string; receipt?: ControlMutationReceipt; outcome: BridgeOutcome } = {
            body,
            outcome: { state: 'pending' },
          };
          this.#bridgeResults.set(key, entry);
          try {
            entry.receipt = await port.bridgeSubmit!(params, (outcome) => {
              entry.outcome = boundedOutcome(outcome);
            });
            if (entry.receipt.delivery === 'rejected') entry.outcome = { state: 'rejected' };
            return entry.receipt;
          } catch (cause) {
            if ((cause as { code?: string })?.code === 'conflict') {
              this.#bridgeResults.delete(key);
              throw cause;
            }
            entry.outcome = { state: 'interrupted' };
            // Outcome uncertain: retain the key, never admit this request twice.
            entry.receipt = { delivery: 'rejected', reason: 'uncertain_admission' };
            return entry.receipt;
          }
        });
        if (result) reply(true, result);
        else reply(false, undefined, 'conflict', 'Bridge request body changed');
        return helloSeen;
      }
      if (request.method === 'submit' || request.method === 'steer') {
        const params = request.params;
        if (
          !params ||
          typeof params !== 'object' ||
          Array.isArray(params) ||
          Object.keys(params).some((key) => !['text', 'clientRequestId', 'origin'].includes(key)) ||
          typeof params.text !== 'string' ||
          params.text.length < 1 ||
          params.text.length > 128_000 ||
          !params.text.trim() ||
          typeof params.clientRequestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(params.clientRequestId) ||
          (params.origin !== undefined &&
            (!params.origin ||
              typeof params.origin !== 'object' ||
              Array.isArray(params.origin) ||
              Object.keys(params.origin).some((key) => key !== 'kind') ||
              !['orchestrator', 'peer'].includes(params.origin.kind)))
        ) {
          reply(false, undefined, 'invalid_request', 'Expected text and an opaque clientRequestId');
          return helloSeen;
        }
        if (params.origin?.kind === 'peer') {
          reply(false, undefined, 'unavailable', 'Peer-originated messages are unavailable in milestone 1');
          return helloSeen;
        }
        const sessionId = this.#context.sessionId();
        const key = JSON.stringify([sessionId, params.clientRequestId]);
        const body = {
          sessionId,
          delivery: request.method === 'steer' ? 'steer' : 'follow_up',
          text: params.text,
          origin: params.origin === undefined ? null : { kind: params.origin.kind },
        };
        const mutate = request.method === 'submit' ? port.submit : port.steer;
        if (!mutate) {
          reply(false, undefined, 'unavailable', 'Mutation is not available');
          return helloSeen;
        }
        const result = await this.#context
          .runMutation(async () => {
            if (port !== this.#context.port() || sessionId !== this.#context.sessionId())
              throw new ControlMutationUnavailable('Session binding changed; retry explicitly.');
            const prior = this.#idempotency.get(key, body);
            if (prior.kind === 'conflict')
              throw Object.assign(new Error('clientRequestId was already used with a different body'), {
                code: 'conflict',
              });
            if (prior.kind === 'replay') return { ...prior.receipt, replayed: true };
            if (!this.#idempotency.canStore()) {
              return { delivery: 'rejected', reason: 'idempotency_capacity' } as ControlMutationReceipt;
            }
            const receipt = await mutate.call(port, {
              ...params,
              onSteerSettled: () => this.#idempotency.settle(key),
            });
            this.#idempotency.set(key, body, receipt, receipt.delivery === 'steering');
            if (receipt.delivery !== 'steering') this.#idempotency.settle(key);
            return receipt;
          })
          .catch((cause: any) => {
            if (cause?.code === 'conflict') {
              reply(false, undefined, 'conflict', cause.message);
              return null;
            }
            throw cause;
          });
        if (!result) return helloSeen;
        reply(true, result);
        return helloSeen;
      }
      if (request.method === 'interrupt') {
        if (!port.interrupt) {
          reply(false, undefined, 'unavailable', 'Interrupt is not available');
          return helloSeen;
        }
        const interrupt = this.#context.interruptHandler();
        reply(
          true,
          await this.#context.runMutation(() => {
            if (port !== this.#context.port())
              throw new ControlMutationUnavailable('Session binding changed; retry explicitly.');
            return interrupt ? interrupt() : port.interrupt!();
          }),
        );
        return helloSeen;
      }
      if (request.method === 'status') {
        reply(true, port.status());
        return helloSeen;
      }
      const params = request.params;
      if (params?.topic === 'transcript') {
        reply(false, undefined, 'unavailable', 'Transcript reads are not available in protocol v1 milestone 1');
        return helloSeen;
      }
      if (
        !params ||
        typeof params !== 'object' ||
        typeof params.topic !== 'string' ||
        !CONTROL_TOPICS.includes(params.topic)
      ) {
        reply(false, undefined, 'invalid_request', 'Unknown or invalid topic');
        return helloSeen;
      }
      if (params.limit !== undefined || params.before !== undefined) {
        reply(false, undefined, 'invalid_request', 'limit and before are only supported for transcript');
        return helloSeen;
      }
      reply(true, port.get(params.topic));
      return helloSeen;
    } catch (cause) {
      if (cause instanceof ControlMutationUnavailable) reply(false, undefined, 'unavailable', cause.message);
      else if ((cause as { code?: string })?.code === 'conflict')
        reply(false, undefined, 'conflict', (cause as Error).message);
      else reply(false, undefined, 'internal', 'Control request failed');
      return helloSeen;
    } finally {
      inFlight.delete(id);
    }
  }
}
