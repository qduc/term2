/** Runtime command decoding shared by local and remote transports. Invalid input has no effect. */
import type {
  WireAnswerProvenance,
  WireBudgetDecision,
  WireCommand,
  WireConfigureRequest,
  WireContent,
  WireDecision,
  WireOrigin,
  WireQuestionAnswer,
} from './direct-wire.js';
import { DirectProtocolError } from './direct-errors.js';

type ObjectValue = Record<string, unknown>;
const invalid = (message: string): never => {
  throw new DirectProtocolError('invalid_command', message);
};
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected command object');
  return value as ObjectValue;
}
function fields(value: ObjectValue, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown command field: ${key}`);
}
function text(value: unknown, name: string): string {
  return typeof value === 'string' ? value : invalid(`Expected string ${name}`);
}
function id(value: unknown, name: string): string {
  const result = text(value, name);
  return result.length > 0 ? result : invalid(`Expected nonempty ${name}`);
}
function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : invalid(`Invalid ${name}`);
}
function decision(raw: unknown): WireDecision {
  const value = object(raw);
  fields(value, ['kind', 'reason', 'answer', 'answers', 'grant', 'stopAfterApprovalResolution']);
  if (value.stopAfterApprovalResolution !== undefined && typeof value.stopAfterApprovalResolution !== 'boolean')
    invalid('Expected boolean stopAfterApprovalResolution');
  const stop =
    value.stopAfterApprovalResolution === undefined
      ? {}
      : { stopAfterApprovalResolution: value.stopAfterApprovalResolution as boolean };
  if (value.kind !== 'answers' && value.answers !== undefined) invalid('This decision has no answer set');
  if (value.kind !== 'grant' && value.grant !== undefined) invalid('This decision has no grant');
  switch (value.kind) {
    case 'decline':
      if (value.reason !== undefined || value.answer !== undefined) invalid('Decline has no answer/reason');
      return { kind: 'decline', ...stop };
    case 'answers': {
      if (!Array.isArray(value.answers) || value.reason !== undefined || value.answer !== undefined)
        invalid('Expected structured question answers');
      const answers: WireQuestionAnswer[] = (value.answers as unknown[]).map((raw) => {
        const answer = object(raw);
        fields(answer, ['questionId', 'value']);
        const result = Array.isArray(answer.value)
          ? answer.value.map((item) => text(item, 'answer value'))
          : text(answer.value, 'answer value');
        return { questionId: id(answer.questionId, 'questionId'), value: result };
      });
      return { kind: 'answers', answers, ...stop };
    }
    case 'grant':
      if (value.reason !== undefined || value.answer !== undefined) invalid('Grant has no answer/reason');
      return {
        kind: 'grant',
        grant: choice(
          value.grant,
          [
            'allow-remember',
            'unsandboxed-once',
            'allow-folder-session',
            'allow-edit-file-session',
            'allow-edit-folder-session',
            'docker-allow-once',
            'docker-allow-session',
            'docker-allow-project',
          ],
          'grant',
        ),
        ...stop,
      };
    case 'allow':
      if (value.reason !== undefined || value.answer !== undefined) invalid('Allow has no answer/reason');
      return { kind: 'allow', ...stop };
    case 'deny':
      if (value.answer !== undefined) invalid('Deny has no question answer');
      return { kind: 'deny', ...(value.reason !== undefined ? { reason: text(value.reason, 'reason') } : {}), ...stop };
    case 'answer':
      if (value.reason !== undefined) invalid('Question answer has no denial reason');
      return { kind: 'answer', answer: text(value.answer, 'answer'), ...stop };
    default:
      return invalid('Invalid interaction decision');
  }
}
function content(raw: unknown): WireContent {
  const value = object(raw);
  if (value.type === 'text') {
    fields(value, ['type', 'text']);
    return { type: 'text', text: text(value.text, 'text') };
  }
  if (value.type !== 'image') return invalid('Invalid attachment type');
  fields(value, ['type', 'mediaType', 'data', 'detail']);
  const data = text(value.data, 'data');
  const padding = data.indexOf('=');
  if (
    !data.length ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data) ||
    (padding >= 0 && (padding < data.length - 2 || (padding === data.length - 2 && !data.endsWith('=='))))
  )
    invalid('Image data must be raw padded base64, not a path, URL or data URI');
  const mediaType = id(value.mediaType, 'mediaType');
  if (!/^image\/[a-zA-Z0-9.+-]+$/.test(mediaType)) invalid('Expected image media type');
  return {
    type: 'image',
    mediaType,
    data,
    ...(value.detail !== undefined ? { detail: text(value.detail, 'detail') } : {}),
  };
}
export function parseWireOrigin(raw: unknown): WireOrigin {
  const value = object(raw);
  if (value.kind === 'discord') {
    fields(value, ['kind', 'source', 'sender', 'discordMessageId', 'relayedBy']);
    return {
      kind: 'discord',
      source: choice(value.source, ['human', 'agent', 'reaction'], 'Discord source'),
      sender: id(value.sender, 'Discord sender'),
      ...(value.discordMessageId !== undefined
        ? { discordMessageId: id(value.discordMessageId, 'Discord message id') }
        : {}),
      ...(value.relayedBy !== undefined ? { relayedBy: id(value.relayedBy, 'Discord relay') } : {}),
    };
  }
  if (value.kind === 'control') {
    fields(value, ['kind', 'id', 'source']);
    return {
      kind: 'control',
      ...(value.id !== undefined ? { id: id(value.id, 'origin id') } : {}),
      ...(value.source !== undefined
        ? { source: choice(value.source, ['orchestrator'] as const, 'control source') }
        : {}),
    };
  }
  if (value.kind === 'tui' && value.skill !== undefined) {
    fields(value, ['kind', 'id', 'skill']);
    const skill = object(value.skill);
    fields(skill, ['name', 'request']);
    return {
      kind: 'tui',
      ...(value.id !== undefined ? { id: id(value.id, 'origin id') } : {}),
      skill: { name: id(skill.name, 'skill name'), request: text(skill.request, 'skill request') },
    };
  }
  fields(value, ['kind', 'id']);
  return {
    kind: choice(value.kind, ['cli', 'tui', 'acp', 'api'], 'origin'),
    ...(value.id !== undefined ? { id: id(value.id, 'origin id') } : {}),
  };
}
function provenance(raw: unknown): WireAnswerProvenance {
  const value = object(raw);
  fields(value, ['source', 'automaticApproval']);
  if (value.automaticApproval !== undefined && typeof value.automaticApproval !== 'boolean')
    invalid('Expected boolean automaticApproval');
  return {
    source: choice(value.source, ['user', 'policy', 'system'], 'answer source'),
    ...(value.automaticApproval !== undefined ? { automaticApproval: value.automaticApproval as boolean } : {}),
  };
}
function budgetDecision(raw: unknown): WireBudgetDecision {
  const value = object(raw);
  switch (value.kind) {
    case 'extend':
      fields(value, ['kind', 'grantedBy']);
      return { kind: 'extend', grantedBy: choice(value.grantedBy, ['human', 'parent'], 'budget grant source') };
    case 'stop':
      fields(value, ['kind']);
      return { kind: 'stop' };
    case 'steer': {
      fields(value, ['kind', 'items']);
      if (!Array.isArray(value.items)) return invalid('Expected budget steering items');
      return {
        kind: 'steer',
        items: value.items.map((raw) => {
          const item = object(raw);
          fields(item, ['type', 'id', 'content']);
          if (item.type !== 'user_message' || !Array.isArray(item.content))
            return invalid('Expected user budget steering content');
          return { type: 'user_message', id: id(item.id, 'item id'), content: item.content.map(content) };
        }),
      };
    }
    default:
      return invalid('Invalid budget decision');
  }
}
function commandPreconditions(value: ObjectValue): { readonly admission?: 'idle'; readonly expectedRevision?: string } {
  const admission =
    value.admission === undefined
      ? {}
      : value.admission === 'idle'
      ? { admission: 'idle' as const }
      : invalid('admission must be idle when supplied');
  return {
    ...admission,
    ...(value.expectedRevision !== undefined
      ? { expectedRevision: id(value.expectedRevision, 'expectedRevision') }
      : {}),
  };
}
function configureRequest(raw: unknown): WireConfigureRequest {
  const value = object(raw);
  fields(value, ['model', 'reasoning', 'temperature', 'profileId']);
  if (
    value.model === undefined &&
    value.reasoning === undefined &&
    value.temperature === undefined &&
    value.profileId === undefined
  )
    invalid('Empty configuration patch');
  let model: WireConfigureRequest['model'];
  if (value.model !== undefined) {
    const ref = object(value.model);
    fields(ref, ['provider', 'model']);
    model = { provider: id(ref.provider, 'provider'), model: id(ref.model, 'model') };
  }
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)))
    invalid('Expected finite temperature');
  return {
    ...(model ? { model } : {}),
    ...(value.reasoning !== undefined
      ? {
          reasoning: choice(
            value.reasoning,
            ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const,
            'reasoning',
          ),
        }
      : {}),
    ...(value.temperature !== undefined ? { temperature: value.temperature as number } : {}),
    ...(value.profileId !== undefined ? { profileId: id(value.profileId, 'profileId') } : {}),
  };
}
/** Does not normalize user text, request identities, or grant authority. Session owns admission/policy. */
export function parseWireCommand(raw: unknown): WireCommand {
  const value = object(raw);
  switch (value.type) {
    case 'submit': {
      fields(value, ['type', 'requestId', 'text', 'attachments', 'origin', 'delivery', 'expectedSteerTurnId']);
      if (value.attachments !== undefined && !Array.isArray(value.attachments)) invalid('Expected attachments array');
      if (value.expectedSteerTurnId !== undefined && value.delivery !== 'steer')
        invalid('Expected steer turn requires steer delivery');
      return {
        type: value.type,
        requestId: id(value.requestId, 'requestId'),
        text: text(value.text, 'text'),
        ...(value.attachments !== undefined ? { attachments: (value.attachments as unknown[]).map(content) } : {}),
        ...(value.origin !== undefined ? { origin: parseWireOrigin(value.origin) } : {}),
        ...(value.expectedSteerTurnId !== undefined
          ? { expectedSteerTurnId: id(value.expectedSteerTurnId, 'expected steer turn') }
          : {}),
        ...(value.delivery !== undefined
          ? { delivery: choice(value.delivery, ['auto', 'steer', 'follow_up', 'reject_if_busy'] as const, 'delivery') }
          : {}),
      };
    }
    case 'answer':
      fields(value, ['type', 'requestId', 'decision', 'provenance']);
      return {
        type: 'answer',
        requestId: id(value.requestId, 'requestId'),
        decision: decision(value.decision),
        ...(value.provenance !== undefined ? { provenance: provenance(value.provenance) } : {}),
      };
    case 'answer_budget':
      fields(value, ['type', 'requestId', 'decision', 'provenance']);
      return {
        type: 'answer_budget',
        requestId: id(value.requestId, 'requestId'),
        decision: budgetDecision(value.decision),
        ...(value.provenance !== undefined ? { provenance: provenance(value.provenance) } : {}),
      };
    case 'cancel': {
      fields(value, ['type', 'target', 'expectedTurnId', 'discardQueue', 'returnSteers']);
      if (
        value.discardQueue !== undefined &&
        (typeof value.discardQueue !== 'boolean' || value.expectedTurnId === undefined)
      )
        invalid('discardQueue requires an expected-turn abort');
      if (
        value.returnSteers !== undefined &&
        (typeof value.returnSteers !== 'boolean' ||
          value.expectedTurnId === undefined ||
          (value.returnSteers === true && value.discardQueue !== false))
      )
        invalid('returnSteers requires a targeted abort that retains the queue');
      const expected =
        value.expectedTurnId !== undefined
          ? {
              expectedTurnId: id(value.expectedTurnId, 'expectedTurnId'),
              ...(value.discardQueue !== undefined ? { discardQueue: value.discardQueue as boolean } : {}),
              ...(value.returnSteers !== undefined ? { returnSteers: value.returnSteers as boolean } : {}),
            }
          : {};
      if (value.target === undefined) return { type: 'cancel', ...expected };
      const target = object(value.target);
      if (target.kind === 'foreground') {
        fields(target, ['kind']);
        return { type: 'cancel', target: { kind: 'foreground' }, ...expected };
      }
      fields(target, ['kind', 'id']);
      if (target.kind !== 'task') return invalid('Invalid cancellation target');
      if (value.expectedTurnId !== undefined) return invalid('Expected turn cannot target a task');
      return { type: 'cancel', target: { kind: 'task', id: id(target.id, 'task id') } };
    }
    case 'retry':
      fields(value, ['type', 'commandId', 'target', 'executionId', 'admission', 'expectedRevision']);
      if (value.target === 'turn' && value.executionId !== undefined)
        invalid('Turn retry cannot target a tool execution');
      return {
        type: 'retry',
        commandId: id(value.commandId, 'commandId'),
        target: choice(value.target, ['turn', 'tool'], 'retry target'),
        ...(value.executionId !== undefined ? { executionId: id(value.executionId, 'executionId') } : {}),
        ...commandPreconditions(value),
      };
    case 'configure':
      fields(value, ['type', 'commandId', 'configuration', 'admission', 'expectedRevision']);
      return {
        type: 'configure',
        commandId: id(value.commandId, 'commandId'),
        configuration: configureRequest(value.configuration),
        ...commandPreconditions(value),
      };
    case 'queue_edit':
      fields(value, ['type', 'messageId', 'text', 'attachments']);
      if (value.attachments !== undefined && !Array.isArray(value.attachments)) invalid('Expected attachments array');
      return {
        type: 'queue_edit',
        messageId: id(value.messageId, 'messageId'),
        text: text(value.text, 'text'),
        ...(value.attachments !== undefined ? { attachments: (value.attachments as unknown[]).map(content) } : {}),
      };
    case 'queue_retract':
      fields(value, ['type', 'messageId']);
      return { type: 'queue_retract', messageId: id(value.messageId, 'messageId') };
    case 'task_control':
      fields(value, ['type', 'taskId', 'action']);
      return {
        type: 'task_control',
        taskId: id(value.taskId, 'taskId'),
        action: choice(value.action, ['cancel', 'check_in', 'foreground', 'background'], 'task action'),
      };
    case 'rewind':
      fields(value, ['type', 'commandId', 'targetId', 'admission', 'expectedRevision']);
      return {
        type: 'rewind',
        commandId: id(value.commandId, 'commandId'),
        targetId: id(value.targetId, 'targetId'),
        ...commandPreconditions(value),
      };
    case 'preview':
      fields(value, ['type', 'text', 'attachments']);
      if (value.attachments !== undefined && !Array.isArray(value.attachments)) invalid('Expected attachments array');
      return {
        type: 'preview',
        text: text(value.text, 'text'),
        ...(value.attachments !== undefined ? { attachments: (value.attachments as unknown[]).map(content) } : {}),
      };
    case 'drain_background_notifications':
      fields(value, ['type', 'requestId']);
      return { type: 'drain_background_notifications', requestId: id(value.requestId, 'requestId') };
    case 'compact':
    case 'rollover':
      fields(value, ['type', 'commandId', 'admission', 'expectedRevision']);
      return { type: value.type, commandId: id(value.commandId, 'commandId'), ...commandPreconditions(value) };
    case 'command_status':
      fields(value, ['type', 'commandId']);
      return { type: value.type, commandId: id(value.commandId, 'commandId') };
    case 'command_revision':
      fields(value, ['type']);
      return { type: value.type };
    case 'queue_resume':
    case 'queue_discard':
    case 'list_rewind_targets':
    case 'reset':
      fields(value, ['type']);
      return { type: value.type };
    default:
      return invalid('Unknown direct command type');
  }
}
