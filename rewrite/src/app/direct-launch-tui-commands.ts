import { formatModelUsageBreakdown, summarizeModelUsage } from '../../../source/services/cost/model-cost.js';
import { resetSession } from '../clients/tui/commands.js';
import { loadProviderItems } from '../../../source/providers/provider-service.js';
/**
 * The slash commands no wire command covers by itself. Each one is either a real
 * host or wire operation here, or it fails visibly. The TUI sends `/compact`, `/retry-*`,
 * `/queue`, `/answer`, `/steer`, `/followup`, `/cancel`, `/clear`, `/rollover` and
 * `/rewind` itself, and calls `switchSession` or `bridge` here for the app's part.
 *
 * A replacement always attaches fresh, so there is no retained cursor: this host's
 * connections cannot drop, and a fresh snapshot needs no reasoning about what
 * transient state a cursor covers.
 */
import { randomUUID } from 'node:crypto';
import { createDurableGoal, formatGoalStatus } from '../../../source/services/conversation/durable-goal.js';
import { composeHandoffMessage } from '../../../source/services/handoff/handoff-flow-reducer.js';
import { formatMcpStatus } from '../../../source/services/mcp/mcp-status.js';
import type { DirectMcp } from './direct-mcp.js';
import { injectSkillIntoTurn } from '../../../source/types/user-turn.js';
import { formatSessionTokenUsage } from '../../../source/utils/ai/token-usage.js';
import { helpText } from '../clients/tui/slash-commands.js';
import { copyToClipboard } from '../../../source/utils/clipboard.js';
import { isControlSocketName } from '../clients/control/index.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import { previewConfirmation, receiptNotice, sendNativeCommand, submitText } from '../clients/tui/commands.js';
import type { BridgeStatus, TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireCommand, WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectSessionTarget } from './direct-application-target.js';
import type { DirectControlBridge } from './direct-launch-control.js';
import { prepareRestart, type DirectRestartPlan } from './direct-launch-tui-restart.js';
import { createDirectTuiSettings } from './direct-launch-tui-settings.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

export type DirectTuiCommandOptions = {
  readonly app: DirectApplication;
  readonly modelCatalog: (
    sessionId: string,
    provider: string,
  ) => Promise<{ models: readonly { id: string }[]; error?: string }>;
  readonly root: string;
  readonly mcp?: DirectMcp;
  readonly onMcpAuthorizationUrl?: (url: string) => void;
  readonly bridge: DirectControlBridge;
  readonly remote?: DirectSessionTarget['restart'];
  /** The current session as this client last folded it. */
  readonly latest: () => WireSnapshot;
  /** Shows this connection. Control has already moved or closed, so the two never disagree. */
  readonly publish: (connection: DirectConnection) => void;
  /** The app closes the host, then runs this plan. */
  readonly restart: (plan: DirectRestartPlan) => void;
};

type Configuration = Extract<WireCommand, { type: 'configure' }>['configuration'];

/**
 * One typed command, one id, sent once. The notice names the id, because a pending
 * or lost reply is read back with `/command-status`, never by sending it again.
 */
async function configure(
  connection: TuiConnection,
  configuration: Configuration,
  /** What a completed change says, so the user sees the new value rather than a command id. */
  done?: string,
): Promise<CommandResult> {
  const command = { type: 'configure', commandId: randomUUID(), configuration } as const;
  const result = await sendNativeCommand(connection, command);
  const configured = result.kind === 'finished' && result.receipt.outcome?.kind === 'configured';
  if (configured && done) return { message: done };
  if (result.kind === 'rejected' || result.kind === 'error') {
    const outcome = result.receipt?.outcome;
    throw new Error(outcome?.kind === 'rejected' ? outcome.message : result.message.replace(/^[a-z_]+: /, ''));
  }
  return { message: receiptNotice(result) };
}

/** `2026-11-02 20:22` in the user's own time zone; the log stores UTC. */
function localMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(
    date.getMinutes(),
  )}`;
}

function parseModel(reference: string | undefined): { provider: string; model: string } {
  const separator = reference?.indexOf('/') ?? -1;
  if (!reference || separator <= 0 || separator === reference.length - 1) throw new Error('Use <provider>/<model>.');
  return { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
}

function assistantTexts(snapshot: WireSnapshot): readonly string[] {
  return snapshot.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
    .filter((text) => text.length > 0);
}

export function createDirectTuiCommands(options: DirectTuiCommandOptions): TuiIntegration {
  const { app, root, bridge, remote, latest, publish, restart } = options;
  const { host, principal } = app;

  const configuration = createDirectTuiSettings(app, latest);

  const listResumeSessions = async () => {
    const sessions: Array<{
      id: string;
      title?: string;
      updatedAt?: string;
      firstUserMessage?: string;
      messageCount?: number;
      model?: string;
    }> = [];
    let cursor: string | undefined;
    do {
      const page = await host.listSessions(principal, cursor);
      sessions.push(
        ...page.sessions
          .filter((session) => session.workspace.root === root)
          .map((session) => ({
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            firstUserMessage: session.title,
            messageCount: session.messageCount,
            model: `${session.model.provider}/${session.model.model}`,
          })),
      );
      cursor = page.cursor;
    } while (cursor);
    return sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  };

  const resume = async (sessionId: string | undefined): Promise<CommandResult> => {
    if (sessionId && sessionId !== 'ls') {
      return { sessionId };
    }
    const here = (await listResumeSessions()).map((session) =>
      [session.id, session.updatedAt ? localMinute(session.updatedAt) : undefined, session.title ?? '(no messages yet)']
        .filter(Boolean)
        .join('  '),
    );
    return { message: here.length ? here.join('\n') : 'No direct sessions in this workspace.' };
  };

  const model = async (connection: TuiConnection, reference: string | undefined): Promise<CommandResult> => {
    if (!reference) {
      const current = app.sessionDetails(connection.sessionId).settings?.get('agent.modelSelection');
      return {
        message: `${
          current ? `Current model: ${current.provider}/${current.model}. ` : ''
        }Choose a model: enter <provider>/<model>.`,
      };
    }
    const selected = parseModel(reference);
    const catalog = await options.modelCatalog(connection.sessionId, selected.provider);
    if (catalog.error || catalog.models.length === 0) {
      throw new Error(
        `Cannot validate ${reference}: ${
          catalog.error || 'provider model catalog is unavailable or empty'
        }. Current model unchanged.`,
      );
    }
    if (!catalog.models.some((model) => model.id === selected.model)) {
      throw new Error(
        `Unknown model ${reference}. Current model unchanged. Available models: ${catalog.models
          .map((model) => `${selected.provider}/${model.id}`)
          .join(', ')}.`,
      );
    }
    return configure(connection, { model: selected }, `Model set to ${reference}.`);
  };

  const effort = async (connection: TuiConnection, value: string | undefined): Promise<CommandResult> => {
    if (!value)
      return {
        message: 'Use /effort default|none|minimal|low|medium|high|xhigh.',
      };
    if (!['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value))
      throw new Error(`Unknown effort '${value}'. Use: default, none, minimal, low, medium, high, xhigh.`);
    return configure(
      connection,
      { reasoning: value as NonNullable<Configuration['reasoning']> },
      `Reasoning effort set to ${value}.`,
    );
  };

  /** `/goal`, with the same arguments as today. A failed update is a message, not an error. */
  const goal = async (sessionId: string, input: string): Promise<CommandResult> => {
    const [action, ...parts] = input.trim().split(/\s+/);
    const empty = 'No durable goal is set. Use /goal set <outcome> [--criteria <text>].';
    const write = async (next: Parameters<typeof formatGoalStatus>[0]): Promise<CommandResult> => {
      await app.setGoal(sessionId, next, 'user');
      return { message: formatGoalStatus(next) };
    };
    try {
      if (!action || action === 'show') {
        const current = await app.goal(sessionId);
        return { message: current ? formatGoalStatus(current) : empty };
      }
      if (action === 'set') {
        const text = parts.join(' ');
        const marker = text.indexOf(' --criteria ');
        const outcome = marker < 0 ? text : text.slice(0, marker);
        const criteria = marker < 0 ? undefined : text.slice(marker + ' --criteria '.length);
        return await write(createDurableGoal(outcome, criteria));
      }
      if (action === 'achieved' || action === 'abandon') {
        const current = await app.goal(sessionId);
        if (!current) throw new Error('No durable goal is set. Use /goal set <outcome> first.');
        return await write({ ...current, status: action === 'achieved' ? 'achieved' : 'abandoned' });
      }
      return { message: 'Usage: /goal [show|set <outcome> [--criteria <text>]|achieved|abandon]' };
    } catch (error) {
      return { message: `Goal update failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const bridgeStatus = (): BridgeStatus => {
    const { server, isStartup } = bridge;
    return {
      sessionId: latest().sessionId,
      startup: isStartup,
      attachment: server
        ? { name: server.name, socketPath: server.socketPath, discordInputEnabled: server.discordInputEnabled }
        : null,
    };
  };

  const copy = async (argument: string | undefined): Promise<CommandResult> => {
    const back = argument === undefined ? 1 : Number(argument);
    if (!Number.isSafeInteger(back) || back < 1) {
      throw new Error('Copy response number must be a positive whole number, e.g. /copy 2.');
    }
    const texts = assistantTexts(latest());
    const text = texts[texts.length - back];
    if (text === undefined) return { message: 'No assistant response to copy.' };
    await copyToClipboard(text);
    return { message: 'Copied to clipboard.' };
  };

  const usage = (): CommandResult => {
    const snapshot = latest();
    const { inputTokens, outputTokens, cachedInputTokens } = snapshot.usage;
    const total = formatSessionTokenUsage({
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      cache_read_tokens: cachedInputTokens,
    });
    const breakdown = formatModelUsageBreakdown(
      summarizeModelUsage((snapshot.requestCosts ?? []).map(({ record }) => record)),
    );
    return { transcript: breakdown ? `${total}\n${breakdown}` : total };
  };

  /** A skill always belongs to a request, so naming one alone hands the line back to finish. */
  const skills = async (connection: TuiConnection, input: string): Promise<CommandResult> => {
    if (remote) return { message: 'Skills are read from this machine, so they are not available over SSH.' };
    const [, name, request] = /^\/skills(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(input.trim()) ?? [];
    const available = app.skills(root);
    if (!name) {
      const list = available.map((skill) => `${skill.name}: ${skill.description}`);
      return { message: list.length ? list.join('\n') : 'No skills found.' };
    }
    const skill = available.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!skill) return { message: `Unknown skill: "${name}". Use /skills to list them.` };
    if (!request) {
      return {
        message: `Skill "${skill.name}": type your request after it.`,
        draft: { text: `/skills ${skill.name} `, attachments: [] },
      };
    }
    const { name: skillName, description, body } = skill;
    const turn = { text: request, skill: { name: skillName, description, body } };
    const injected = injectSkillIntoTurn(turn).text;
    // Hand the expanded request back as an ordinary draft; Enter then confirms like any other send.
    // Enter already cleared the typed line: if the preview itself fails, hand it back instead of losing it.
    let held: string | null;
    try {
      held = await previewConfirmation(connection, injected);
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        draft: { text: input.trim(), attachments: [] },
      };
    }
    if (held !== null)
      return {
        message: `${held} Not sent; the request is in the input box.`,
        draft: { text: injected, attachments: [] },
      };
    await submitText(connection, injected);
    return {};
  };

  const handoff = async (connection: TuiConnection, input: string): Promise<CommandResult> => {
    const captured = assistantTexts(latest()).at(-1);
    if (captured === undefined) return { message: 'No assistant response available to hand off.' };
    const args = input.trim().slice('/handoff'.length).trim();
    const [first] = args.split(/\s+/);
    const named = first?.includes('/') ? parseModel(first) : undefined;
    const handoffMessage = (named ? args.slice(first!.length) : args).trim() || undefined;
    const text = composeHandoffMessage({
      capturedText: captured,
      stage: 'selecting_model',
      ...(handoffMessage ? { handoffMessage } : {}),
    });
    return { sessionId: await app.handoff(connection.sessionId, named, text) };
  };

  const requireMcp = (): DirectMcp => {
    if (remote) throw new Error('MCP servers are not available over SSH in this executable.');
    if (!options.mcp) throw new Error('MCP is not enabled for this application.');
    return options.mcp;
  };

  return {
    resumePicker: { list: listResumeSessions },
    settingsPicker: { list: configuration.picker },
    planNeedsClear: configuration.planNeedsClear,
    async clearAndTogglePlan(connection) {
      const target = configuration.planTarget(connection);
      const id = await resetSession(connection);
      try {
        const next = await host.connect(principal, id);
        const result = await configuration.profile(next, target);
        if (
          result.message !== `Switched to ${target} for this session.` &&
          result.message !== `${target} is already active.`
        ) {
          next.close();
          throw new Error(result.message ?? 'Mode configuration did not finish.');
        }
        await bridge.rebind(id);
        publish(next);
        return { message: result.message };
      } catch (error) {
        throw new Error(
          `Session ${id} was created but mode switching failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    async command(connection, input) {
      const [name, ...rest] = input.trim().slice(1).split(/\s+/);
      const argument = rest[0];
      switch (name) {
        case 'help':
          return { message: helpText() };
        case 'quit':
        case 'exit':
          return { exit: true };
        case 'resume':
          return resume(argument);
        case 'model':
          return model(connection, argument);
        case 'effort':
          return effort(connection, argument);
        case 'copy':
          return copy(argument);
        case 'usage':
          return usage();
        case 'providers': {
          const settings = app.sessionDetails(connection.sessionId).settings;
          if (!settings) throw new Error('The attached session has no live settings.');
          const providers = loadProviderItems(settings);
          return {
            message: providers.length
              ? [
                  'Configured providers:',
                  ...providers.map(
                    (provider) =>
                      `${provider.label} (${provider.id}) — ${
                        provider.isDisabled
                          ? 'disabled'
                          : provider.hasCredentials
                          ? 'configured'
                          : 'missing credentials'
                      }${provider.isActive ? ' · active' : ''}`,
                  ),
                ].join('\n')
              : 'No configured providers.',
          };
        }
        case 'sandbox':
          return configuration.sandbox(connection);
        case 'auto-approve':
          return configuration.autoApprove(connection, argument);
        case 'settings':
          return configuration.settings(connection, rest.join(' '));
        case 'plan':
        case 'bare':
        case 'mentor':
        case 'orchestrator':
          return configuration.toggle(connection, name);
        case 'profile':
          return configuration.profile(connection, argument);
        case 'skills':
          return skills(connection, input);
        case 'handoff':
          return handoff(connection, input);
        case 'mcp':
          return { message: formatMcpStatus(requireMcp().status()) };
        case 'mcp-login': {
          if (!argument || rest.length !== 1) throw new Error('Usage: /mcp-login <server>');
          const server = await requireMcp().login(argument, options.onMcpAuthorizationUrl);
          return { message: `MCP server "${server.name}" is ${server.state}.` };
        }
        case 'goal':
          return goal(connection.sessionId, input.trim().slice('/goal'.length));
        case 'restart':
          if (argument && argument !== 'stop') throw new Error('Usage: /restart [stop]');
          restart(
            await prepareRestart(
              latest,
              app,
              bridge,
              remote,
              argument === 'stop' ? (sent) => connection.send(sent) : undefined,
            ),
          );
          return { exit: true };
        default:
          throw new Error(`/${name} is not available in the direct executable yet.`);
      }
    },
    async switchSession(sessionId) {
      // Native rollover rotates the backing log, not this attached logical Session.
      if (sessionId === latest().sessionId) return;
      const next = await host.connect(principal, sessionId);
      // The session has really changed by now, so the client follows it even if control cannot.
      const failure = await bridge.rebind(sessionId).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      publish(next);
      return failure === undefined ? undefined : { message: failure };
    },
    bridge: {
      status: async () => bridgeStatus(),
      async connect(name) {
        if (!isControlSocketName(name))
          throw new Error('Invalid bridge socket name. Use 1–64 letters, digits, _ or -.');
        await bridge.connect(latest().sessionId, name);
        return bridgeStatus();
      },
      async disconnect() {
        if (bridge.isStartup) throw new Error('This startup control socket cannot be disconnected at runtime.');
        await bridge.disconnect();
        return bridgeStatus();
      },
    },
  };
}
