// Importer-owned checks for contracts the legacy recovery decoder intentionally
// does not enforce. Authority: contracts/{conversation-items,provider-input}.ts,
// types/message.ts, tools/types.ts, services/tool-execution-ledger.ts and
// services/logging/conversation-log-events.ts. Never normalize or strip fields.
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string';
const boolean = (v) => typeof v === 'boolean';
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const positive = (v) => integer(v) && v > 0;
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);
const array = (check) => (v) => Array.isArray(v) && v.every(check);
const strings = array(string);
const optional = (v, fields) => Object.entries(fields).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key]));
const required = (v, fields) =>
  object(v) && Object.entries(fields).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
const anything = () => true;
const resultStatus = oneOf('completed', 'failed', 'aborted', 'unknown');
const occurrence = (v) => optional(v, { turnId: string, occurrence: positive });

function assistantItem(v) {
  if (!object(v)) return false;
  switch (v.type) {
    case 'reasoning':
    case 'assistant_text':
      return (
        required(v, { text: string }) &&
        optional(v, {
          providerMetadata: object,
          providerItemId: string,
          ...(v.type === 'reasoning' ? { sequence: integer } : {}),
        })
      );
    case 'tool_call':
      return (
        required(v, { callId: string, toolName: string, arguments: anything }) &&
        occurrence(v) &&
        optional(v, { providerItem: object })
      );
    case 'tool_result':
      return (
        required(v, { callId: string, toolName: string, status: resultStatus, output: anything }) &&
        occurrence(v) &&
        optional(v, {
          providerItem: object,
          runCodeExecution: (r) => required(r, { success: boolean }) && optional(r, { diagnosticCode: string }),
        })
      );
    case 'provider_opaque':
      // The normalized union is closed; the provider's inner item is not.
      return required(v, { provider: string, item: object }) && optional(v, { sourceProvider: string });
    default:
      return false;
  }
}

function providerItem(v) {
  // ProviderInputItem deliberately gives type/role/content/etc unknown types.
  // Do not impose a provider wire schema, even for familiar-looking names.
  return (
    object(v) &&
    optional(v, {
      personalMemoryContext: string,
      providerData: object,
      providerOpaque: (m) => required(m, { provider: string }) && optional(m, { sourceProvider: string }),
      contextSummary: (m) =>
        required(m, { version: oneOf(1), strategy: oneOf('local') }) &&
        optional(m, {
          replacesThroughRevision: integer,
          sourceProvider: string,
          sourceModel: string,
          estimatedTokensBefore: integer,
          estimatedTokensAfter: integer,
          rearmAtEstimatedTokens: integer,
          protectedUsers: array(providerItem),
          toolReceipts: array(
            (r) =>
              required(r, {
                callId: string,
                name: string,
                argumentsSha256: string,
                argumentsPreview: string,
                outputPreview: string,
              }) && optional(r, { display: string }),
          ),
        }),
    })
  );
}

function ledgerEntry(v) {
  return (
    required(v, {
      turnId: string,
      callId: string,
      toolName: string,
      status: oneOf('started', 'completed', 'failed', 'approval_required', 'aborted', 'unknown'),
      startedAt: string,
    }) &&
    occurrence(v) &&
    optional(v, {
      failureReason: string,
      dispatchedAt: string,
      completedAt: string,
      historyItems: Array.isArray,
      userTurnCount: integer,
    })
  );
}

function snapshot(v) {
  return (
    required(v, {
      history: array(providerItem),
      previousResponseId: (id) => id === null || string(id),
      toolLedger: array(ledgerEntry),
    }) && optional(v, { model: string, provider: string })
  );
}

function message(v, sender) {
  if (!required(v, { id: string, sender: oneOf(sender) })) return false;
  if (sender === 'command') {
    return (
      required(v, {
        status: oneOf('pending', 'running', 'completed', 'failed', 'aborted', 'unknown'),
        command: string,
        output: string,
      }) &&
      optional(v, {
        success: boolean,
        failureReason: string,
        isApprovalRejection: boolean,
        autoApprovedByLlm: boolean,
        toolName: string,
        callId: string,
        hadApproval: boolean,
      })
    );
  }
  return (
    required(v, { text: string }) &&
    optional(v, {
      humanInputAt: string,
      humanInputBaseline: string,
      consumedForAbort: boolean,
      presentation: oneOf('session_rollover', 'server_message'),
      skill: (s) => required(s, { name: string, description: string, body: string }),
    })
  );
}

/**
 * Supplement (not replace) decodeLogEnvelope at the strict import boundary.
 * Validate owned normalized structures including all snapshot carriers; provider
 * payloads and additive fields remain verbatim. The caller validates event kinds,
 * batches and envelope identities and collapses false/throws to a safe diagnostic.
 */
export function validPersistedEvent(event) {
  if (!object(event)) return false;
  if (
    ['assistant_turn', 'undo', 'user_input_accepted', 'user_turn_retried', 'tool_output_rewound'].includes(
      event.type,
    ) &&
    Object.hasOwn(event, 'snapshot') &&
    !snapshot(event.snapshot)
  )
    return false;
  switch (event.type) {
    case 'assistant_turn':
      return (
        required(event.turn, { items: array(assistantItem) }) &&
        optional(event, {
          turnId: string,
          providerHistory: array(providerItem),
          state: (s) =>
            required(s, { previousResponseId: (id) => id === null || string(id) }) &&
            optional(s, { model: string, provider: string }),
        })
      );
    case 'assistant_journal_item':
      return integer(event.seq) && assistantItem(event.item);
    case 'assistant_journal_delta':
      return integer(event.seq);
    case 'context_checkpoint_created':
      return providerItem(event.item);
    case 'context_compaction_recorded':
      return event.result?.kind !== 'compacted' || snapshot(event.result.snapshot);
    case 'undo':
      // Replay coerces invalid counts to one. Import must not repair corruption.
      return positive(event.removedUserTurns);
    case 'personal_memory_context':
      return required(event, { humanInputAt: string, snapshot: string });
    case 'user_message':
      return message(event.message, 'user');
    case 'command_message':
      return message(event.message, 'command');
    case 'settings_changed':
      return Object.hasOwn(event, 'value');
    case 'tool_started':
      return Object.hasOwn(event, 'arguments') && optional(event, { turnId: string });
    case 'tool_result':
      return occurrence(event) && optional(event, { historyItems: Array.isArray });
    case 'approval_required':
      return (
        optional(event, { turnId: string }) &&
        optional(event.approval, {
          callId: string,
          argumentsText: string,
          agentName: string,
        })
      );
    case 'approval_resolved':
      return optional(event, { turnId: string, rejectionReason: string });
    case 'session_init':
      return optional(event, {
        projectPath: string,
        sshHost: string,
        activeProfileId: string,
        activeProfileVersion: string,
        activeProfileDigest: string,
        model: string,
        provider: string,
        reasoningEffort: string,
        forkedFrom: string,
        rolloverFrom: string,
        appMode: (m) =>
          required(m, { mentorMode: boolean, liteMode: boolean, planMode: boolean }) &&
          optional(m, { orchestratorMode: boolean }),
      });
    case 'openai_root_selector_parity':
      return (
        required(event, { version: oneOf(2), eligible: boolean, matches: boolean }) &&
        optional(event, {
          turnId: string,
          failure: oneOf(
            'model_unavailable',
            'identity_unavailable',
            'no_accepted_checkpoint',
            'missing_successor_proof',
            'lineage_mismatch',
            'invalid_planned_snapshot',
            'identity_mismatch',
            'origin_mismatch',
            'revision_not_advanced',
            'history_not_extended',
            'history_prefix_mismatch',
          ),
        })
      );
    case 'openai_root_checkpoint_lifecycle':
      return (
        required(event, {
          version: oneOf(1),
          stage: oneOf('candidate', 'publication'),
          outcome: oneOf(
            'observed',
            'missing_prefix_binding',
            'not_prepared',
            'already_consumed',
            'input_mismatch',
            'missing_response_id',
            'invalid_lineage',
            'lineage_rejected',
            'promoted',
            'history_not_committed',
            'candidate_not_promoted',
          ),
        }) && optional(event, { turnId: string })
      );
    case 'subagent_started':
      return optional(event, { parentTool: string, async: boolean });
    case 'subagent_completed':
      return required(event.result, {
        role: string,
        status: oneOf('completed', 'failed', 'cancelled', 'interrupted'),
        finalText: string,
        filesChanged: strings,
        toolsUsed: array((t) => required(t, { toolName: string, count: integer })),
      });
    case 'background_shell_output':
      return (
        integer(event.seq) &&
        optional(event, {
          coalescedCount: integer,
          droppedBytes: integer,
          seqRange: (r) => required(r, { first: integer, last: integer }) && r.first <= r.last,
        })
      );
    case 'session_rollover':
      return (
        required(event, {
          phase: oneOf('requested', 'blocked', 'completed'),
          rolloverId: string,
          sourceSessionId: string,
          briefSize: integer,
        }) &&
        optional(event, { providerInputTokens: integer }) &&
        (event.phase === 'requested' ||
          required(event, { settlementLatencyMs: (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 })) &&
        (event.phase !== 'blocked' || required(event, { blocker: oneOf('background_work', 'pending_interaction') })) &&
        (event.phase !== 'completed' || required(event, { successorSessionId: string }))
      );
    default:
      // Remaining known events have no unchecked required structures. Unknown
      // kinds never reach here: v3-input owns the allowlist and batch expansion.
      return true;
  }
}
