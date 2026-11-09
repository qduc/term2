import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireConfigureRequest, WireModel, WireNativeCommandOutcome } from '../../protocol/wire.js';
import type { BackendOptions } from './contract.js';

const thinkingLevels = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra high' },
] as const satisfies readonly { value: NonNullable<WireConfigureRequest['reasoning']>; name: string }[];

const modelId = (model: WireModel): string => `${model.provider}/${model.model}`;

/**
 * Model and thinking selectors are session-local native configuration. Catalog entries grant
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
    const reasoning = connection.snapshot.configuration.reasoning ?? 'default';
    this.close(connection);
    const configuration = (await this.options.configuration?.(sessionId)) ?? { model: current, reasoning };
    // ACP select options must include the actual current value. Move legacy
    // selections to a visible level through the same native configure command.
    const { reasoning: selected } = configuration;
    const thinking =
      selected === 'default' ? 'medium' : selected === 'none' || selected === 'minimal' ? 'low' : selected;
    const publishThinking = thinking === selected || this.options.configuration !== undefined;
    if (publishThinking && thinking !== selected) await this.configure(sessionId, { reasoning: thinking });
    const models = new Map(catalog.map((model) => [modelId(model), model]));
    models.set(modelId(configuration.model), models.get(modelId(configuration.model)) ?? configuration.model);
    const options: acp.SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: modelId(configuration.model),
        options: [...models.values()].map((model) => ({
          value: modelId(model),
          name: `${model.name ?? model.model} (${model.provider})`,
        })),
      },
    ];
    if (publishThinking) {
      options.push({
        id: 'thinking_level',
        name: 'Thinking level',
        category: 'thought_level',
        type: 'select',
        description: 'Reasoning effort. Supported levels depend on the provider.',
        currentValue: thinking,
        options: [...thinkingLevels],
      });
    }
    return options;
  }

  async setConfigOption(request: acp.SetSessionConfigOptionRequest): Promise<void> {
    if (typeof request.value !== 'string')
      throw acp.RequestError.invalidParams(undefined, 'Expected a configuration selection');
    const catalog = await this.configOptions(request.sessionId);
    const selector = catalog.find((option) => option.id === request.configId);
    if (
      selector?.type !== 'select' ||
      !selector.options.some((option) => 'value' in option && option.value === request.value)
    )
      throw acp.RequestError.invalidParams(undefined, 'Unknown configuration option or value');
    const separator = request.value.indexOf('/');
    const configuration: WireConfigureRequest =
      request.configId === 'model'
        ? { model: { provider: request.value.slice(0, separator), model: request.value.slice(separator + 1) } }
        : { reasoning: request.value as NonNullable<WireConfigureRequest['reasoning']> };
    await this.configure(request.sessionId, configuration);
  }

  private async configure(sessionId: string, configuration: WireConfigureRequest): Promise<void> {
    const connection = await this.connect(sessionId);
    const commandId = randomUUID();
    try {
      const result = await connection.send({ type: 'configure', commandId, configuration });
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
          outcome?.kind === 'rejected' ? outcome.message : 'Configuration change was not confirmed',
        );
      if (
        configuration.model &&
        (outcome.configuration.model.provider !== configuration.model.provider ||
          outcome.configuration.model.model !== configuration.model.model)
      )
        throw new acp.RequestError(-32000, 'Session confirmed a different model');
      if (configuration.reasoning && outcome.configuration.reasoning !== configuration.reasoning)
        throw new acp.RequestError(-32000, 'Session confirmed a different thinking level');
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
