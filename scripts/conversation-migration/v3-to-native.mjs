import { isDeepStrictEqual } from 'node:util';
import { normalizeApplicationInput } from '../../dist/source/services/agent-runtime/application-run-loop.js';
import { getProfileMetadata } from '../../dist/source/services/profiles/active-profile.js';
import { profileIdFromLegacyMode } from '../../dist/source/services/profiles/legacy-adapter.js';
import { itemToInput } from '../../dist/rewrite/src/model/provider-items.js';
import { validateFact } from '../../dist/rewrite/src/session/log-facts.js';
import { replay } from '../../dist/rewrite/src/session/replay.js';

const uuid = /^(?:conv_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const notice =
  'Imported v3 conversation: one interrupted context-restoration wrapper, not a historical execution. ' +
  'Provider continuation was intentionally broken; the next request uses the complete restored context. ' +
  'Usage below is the imported combined foreground and subagent total; request costs are separate receipts.';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const iso = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

class Refusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const refuse = (code) => {
  throw new Refusal(code);
};

function visible(message) {
  switch (message.sender) {
    case 'user':
    case 'system':
    case 'reasoning':
      return message.text;
    case 'bot':
      return [message.reasoningText, message.text].filter((part) => part !== undefined && part !== '').join('\n\n');
    case 'command':
      return [
        message.toolName,
        message.command,
        message.output,
        message.failureReason,
        message.hadApproval === true ? 'Approval was required.' : undefined,
        message.isApprovalRejection === true ? 'Approval rejected.' : undefined,
        message.autoApprovedByLlm === true ? 'Automatically approved by model.' : undefined,
        `Status: ${message.status}`,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n');
    case 'subagent':
      return [
        `Subagent ${message.role}: ${message.status}`,
        message.task,
        ...message.tools.map((tool) => (typeof tool === 'string' ? tool : visible(tool))),
        message.finalText,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n');
    default:
      return refuse('unsupported-message');
  }
}

/**
 * Pure, deterministic reader-result -> regular native facts. Success is private
 * content {id, entries, fidelity}; failure is only {status:'failed', error:{code}}.
 * options.fallback supplies missing provider/model/profileId/workspace only;
 * existing source configuration is never overridden. No I/O or live authority.
 */
export function convertValidatedV3(input, options = {}) {
  try {
    if (input?.status !== 'imported-input' || !object(input.restoredState) || !Array.isArray(input.envelopes))
      refuse('invalid-input');
    // Clone at the boundary: neither adapters nor returned facts can mutate input.
    const state = globalThis.structuredClone(input.restoredState);
    const envelopes = input.envelopes;
    const match = typeof state.id === 'string' && uuid.exec(state.id);
    if (!match) refuse('unsupported-source-id');
    const id = `conv_${match[1]}`;
    const turnId = `${id}-v3-restoration`;
    if (state.sshHost !== undefined) refuse('unsupported-remote-identity');
    if (!envelopes.length || envelopes.some((entry) => !iso(entry.ts)) || !iso(state.createdAt))
      refuse('invalid-timestamp');
    const endAt = envelopes.at(-1).ts;
    const fallback = options.fallback ?? {};
    const provider = state.provider ?? fallback.provider;
    const modelName = state.model ?? fallback.model;
    const derivedProfile = state.activeProfileId === undefined && state.appMode !== undefined;
    if (derivedProfile && !object(state.appMode)) refuse('missing-configuration');
    const profileId =
      state.activeProfileId ?? (derivedProfile ? profileIdFromLegacyMode(state.appMode) : fallback.profileId);
    const workspace = state.projectPath ?? fallback.workspace;
    if (![provider, modelName, profileId, workspace].every(text)) refuse('missing-configuration');
    if (!workspace.startsWith('/')) refuse('unsupported-workspace');
    const reasoning = state.reasoningEffort;
    if (reasoning !== undefined && reasoning !== 'default' && !efforts.has(reasoning)) refuse('unsupported-reasoning');
    const nativeReasoning = reasoning === 'default' ? undefined : reasoning;
    let metadata;
    try {
      metadata = getProfileMetadata(profileId);
    } catch {
      refuse('unsupported-profile');
    }
    const profile = {
      id: metadata.activeProfileId,
      version: metadata.activeProfileVersion,
      digest: metadata.activeProfileDigest,
    };
    // Metadata on the selected init is evidence, not permission to substitute a
    // changed registry profile with the same name.
    const init = envelopes.filter(({ event }) => event.type === 'session_init').at(-1)?.event;
    if (
      (init?.activeProfileId === profileId || (derivedProfile && init?.activeProfileId === undefined)) &&
      ((init.activeProfileVersion !== undefined && init.activeProfileVersion !== profile.version) ||
        (init.activeProfileDigest !== undefined && init.activeProfileDigest !== profile.digest))
    )
      refuse('profile-mismatch');
    if (!Array.isArray(state.messages) || !Array.isArray(state.history)) refuse('invalid-input');
    let normalized;
    try {
      normalized = normalizeApplicationInput(state.history);
    } catch {
      refuse('normalization-refused');
    }
    const entries = [];
    const add = (at, fact) => entries.push({ at, fact });
    const model = { provider, model: modelName };
    add(state.createdAt, {
      type: 'session_started',
      id,
      workspace,
      model,
      profile,
      appVersion: 'v3-offline-converter/1',
      ...(nativeReasoning !== undefined ? { reasoning: nativeReasoning } : {}),
    });
    add(endAt, {
      type: 'configuration_changed',
      profile,
      configuration: {
        model,
        ...(nativeReasoning !== undefined ? { reasoning: nativeReasoning } : {}),
        ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
      },
      intent: {
        modelSelection: model,
        reasoningEffort: reasoning ?? 'default',
        ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
      },
    });
    add(endAt, { type: 'turn_started', turnId, input: [], display: false });
    // Only a directly recorded message event proves its event time. Snapshot
    // appearance and journal-generated IDs do not prove original arrival time.
    const messageTimes = new Map();
    for (const { event, ts } of envelopes) {
      if (object(event.message) && text(event.message.id) && text(event.message.sender)) {
        const times = messageTimes.get(event.message.id) ?? [];
        times.push({ ts, message: event.message });
        messageTimes.set(event.message.id, times);
      }
    }
    let ambiguousMessageTimestamps = 0;
    const noticeId = `${id}-v3-import-notice`;
    const originalIds = new Set(state.messages.map((message) => message?.id));
    const ids = new Set([noticeId]);
    let remappedObservationIdentityCount = 0;
    let generatedId = 0;
    for (const restoredMessage of state.messages) {
      // Replay adds incidental optional undefined properties. Persisted JSON
      // cannot carry them; observations retain the exact durable JSON shape.
      const source = JSON.parse(JSON.stringify(restoredMessage));
      if (!object(source) || !text(source.id)) refuse('invalid-message-identity');
      let observationId = source.id;
      if (ids.has(observationId)) {
        do observationId = `${id}-v3-observation-${generatedId++}`;
        while (originalIds.has(observationId) || ids.has(observationId));
        remappedObservationIdentityCount++;
      }
      ids.add(observationId);
      const matches = (messageTimes.get(source.id) ?? []).filter(({ message }) => isDeepStrictEqual(message, source));
      const times = [...new Set(matches.map(({ ts }) => ts))];
      const known = times.length === 1;
      if (!known) ambiguousMessageTimestamps++;
      const content = visible(source);
      if (typeof content !== 'string') refuse('unsupported-message');
      const role =
        source.sender === 'user'
          ? 'user'
          : source.sender === 'bot'
          ? 'assistant'
          : source.sender === 'command'
          ? 'tool'
          : 'system';
      add(known ? times[0] : endAt, {
        type: 'transcript_message',
        turnId,
        message: {
          id: observationId,
          role,
          content: [{ type: 'text', text: content }],
          presentation: { sourceMessage: source, timestampBasis: known ? 'source-message-event' : 'import-settlement' },
        },
      });
    }
    add(endAt, {
      type: 'transcript_message',
      turnId,
      message: {
        id: noticeId,
        role: 'system',
        content: [{ type: 'text', text: notice }],
        presentation: {
          importNotice: true,
          sourceSettings: {
            ...(state.appMode !== undefined ? { appMode: state.appMode } : {}),
            ...(state.activeProfileId !== undefined ? { activeProfileId: state.activeProfileId } : {}),
            ...(state.reasoningEffort !== undefined ? { reasoningEffort: state.reasoningEffort } : {}),
            ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
          },
          ...(state.usage !== undefined ? { usage: state.usage } : {}),
          ...(state.subagentUsage !== undefined ? { subagentUsage: state.subagentUsage } : {}),
        },
      },
    });
    normalized.forEach((part, index) =>
      add(endAt, {
        type: 'item',
        turnId,
        display: false,
        item: { type: 'provider_input', id: `${id}-v3-context-${index}`, provider, input: part },
      }),
    );
    if (state.goal !== undefined) add(endAt, { type: 'goal_changed', goal: state.goal, source: 'launcher' });
    if (state.usage !== undefined || state.subagentUsage !== undefined) {
      const count = (key) => (state.usage?.[key] ?? 0) + (state.subagentUsage?.[key] ?? 0);
      add(endAt, {
        type: 'usage',
        turnId,
        usage: {
          inputTokens: count('prompt_tokens'),
          outputTokens: count('completion_tokens'),
          cachedInputTokens: count('cache_read_tokens'),
        },
      });
    }
    const costs = state.costRecords ?? [];
    // Native accounting upserts by physical requestId. Retain repeated receipts
    // and corrections in order, without turning each into another usage charge.
    for (const record of costs) add(endAt, { type: 'request_cost_recorded', turnId, rootTurnId: turnId, record });
    add(endAt, { type: 'turn_ended', turnId, outcome: 'interrupted', notice });
    try {
      for (const { fact } of entries) validateFact(fact, 'v3-conversion');
      const restored = replay(entries.map(({ fact }) => fact));
      if (restored.recoveryFacts.length || !isDeepStrictEqual(restored.history.map(itemToInput), normalized))
        refuse('native-context-mismatch');
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse('native-validation-refused');
    }
    return {
      id,
      entries,
      fidelity: {
        sourceEnvelopeCount: envelopes.length,
        sourceMessageCount: state.messages.length,
        sourceUserMessageCount: envelopes.filter(({ event }) => event.type === 'user_message').length,
        sourceStartedTurnCount: envelopes.filter(({ event }) => event.type === 'session_turn_started').length,
        sourceNonConsumedUserMessageCount: envelopes.filter(
          ({ event }) => event.type === 'user_message' && !event.message.consumedForAbort,
        ).length,
        sourceTurnCountAmbiguous: true,
        sourceAcceptedTurnCount: envelopes.filter(({ event }) => event.type === 'user_input_accepted').length,
        sourceAssistantSnapshotCount: envelopes.filter(({ event }) => event.type === 'assistant_turn').length,
        providerInputCount: normalized.length,
        costRecordCount: costs.length,
        ambiguousMessageTimestamps,
        derivedProfileCount: Number(derivedProfile),
        remappedObservationIdentityCount,
        restorationTurnCount: 1,
        continuationBroken: true,
        fallbackFieldCount: [
          state.provider,
          state.model,
          derivedProfile ? profileId : state.activeProfileId,
          state.projectPath,
        ].filter((value) => value === undefined).length,
        replayWarningCount: state.replayWarnings?.length ?? 0,
      },
    };
  } catch (error) {
    return { status: 'failed', error: { code: error instanceof Refusal ? error.code : 'conversion-refused' } };
  }
}
