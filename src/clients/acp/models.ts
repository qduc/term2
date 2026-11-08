import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireModel, WireNativeCommandOutcome } from '../../protocol/wire.js';
import type { BackendOptions } from './contract.js';

const modelId = (model: WireModel): string => `${model.provider}/${model.model}`;

/**
 * Model selectors are session-local native configuration. Catalog entries grant
 * no authority: Host authorizes every read/write and Session validates configure.
 * Separate short-lived subscriptions observe exact command receipts without
 * competing with the display attachment's event consumer.
 */
export class AcpModels {
  private readonly connections = new Set<DirectConnection>();
  private stopped = false;

  constructor(private readonly options: BackendOptions) {}

  private async connect(sessionId: string): Promise<DirectConnection> {
    if (this.stopped) throw new acp.RequestError(-32000, 'ACP backend is shut down');
    const connection = await this.options.host.connect(this.options.principal, sessionId);
    if (this.stopped) {
      connection.close();
      throw new acp.RequestError(-32000, 'ACP backend is shut down');
    }
    this.connections.add(connection);
    return connection;
  }

  private close(connection: DirectConnection): void {
    this.connections.delete(connection);
    connection.close();
  }

  async configOptions(sessionId: string, refresh = false): Promise<acp.SessionConfigOption[]> {
    const catalog = (await this.options.models?.(refresh)) ?? [];
    const connection = await this.connect(sessionId);
    const current = connection.snapshot.model;
    this.close(connection);
    const models = new Map(catalog.map((model) => [modelId(model), model]));
    models.set(modelId(current), models.get(modelId(current)) ?? current);
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: modelId(current),
        options: [...models.values()].map((model) => ({
          value: modelId(model),
          name: `${model.name ?? model.model} (${model.provider})`,
        })),
      },
    ];
  }

  async setConfigOption(request: acp.SetSessionConfigOptionRequest): Promise<acp.SessionConfigOption[]> {
    if (request.configId !== 'model' || typeof request.value !== 'string')
      throw acp.RequestError.invalidParams(undefined, 'Unknown model configuration option');
    const catalog = await this.configOptions(request.sessionId);
    const selector = catalog[0];
    if (
      selector.type !== 'select' ||
      !selector.options.some((option) => 'value' in option && option.value === request.value)
    )
      throw acp.RequestError.invalidParams(undefined, 'Model is not in the available catalog');
    const separator = request.value.indexOf('/');
    const model = { provider: request.value.slice(0, separator), model: request.value.slice(separator + 1) };
    const connection = await this.connect(request.sessionId);
    const commandId = randomUUID();
    try {
      const result = await connection.send({ type: 'configure', commandId, configuration: { model } });
      if (!result.ok) throw new acp.RequestError(-32000, result.message);
      let outcome: WireNativeCommandOutcome | undefined;
      if (result.kind === 'command_finished') outcome = result.receipt.outcome;
      else if (result.kind === 'command_pending') {
        for await (const event of connection.events) {
          if (event.type === 'command_finished' && event.payload.receipt.request.commandId === commandId) {
            outcome = event.payload.receipt.outcome;
            break;
          }
        }
      }
      if (outcome?.kind !== 'configured')
        throw new acp.RequestError(
          -32000,
          outcome?.kind === 'rejected' ? outcome.message : 'Model change was not confirmed',
        );
      if (outcome.configuration.model.provider !== model.provider || outcome.configuration.model.model !== model.model)
        throw new acp.RequestError(-32000, 'Session confirmed a different model');
      return await this.configOptions(request.sessionId);
    } finally {
      this.close(connection);
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const connection of this.connections) connection.close();
    this.connections.clear();
  }
}
