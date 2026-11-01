import { Term2ProtocolError, type AgentChangeV2 } from './types';

type Fields = Readonly<Record<string, unknown>>;
export type NativeRequestCost = Fields & {
  turnId: string; rootTurnId: string; parentTurnId?: string;
  record: Fields & { requestId: string };
};
/** Observed public state only. Undefined is unavailable, null is an actual clear.
 * Request receipts and aggregate cost are independent; this module never sums them. */
export interface NativeState {
  cost?: (Fields & { totalUsd: number; currency: 'USD' }) | null;
  requestCosts?: readonly NativeRequestCost[];
  goal?: Fields | null;
  goalProposal?: Fields | null;
  goalGeneration?: number;
  verification?: Fields | null;
  notices?: readonly Fields[];
  notifications?: { notices?: readonly Fields[]; deliveries?: readonly Fields[] };
}

function fail(): never { throw new Term2ProtocolError('Invalid native public state evidence'); }
function object(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Fields;
}
function string(value: unknown): string { return typeof value === 'string' ? value : fail(); }
function identity(value: unknown): string {
  const result = string(value);
  return result && !/[\u0000-\u001f\u007f]/u.test(result) ? result : fail();
}
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : fail(); }
function ordinal(value: unknown): number { const number = finite(value); return Number.isSafeInteger(number) && number >= 0 ? number : fail(); }
function oneOf(value: unknown, choices: readonly string[]): void { if (!choices.includes(string(value))) fail(); }
function array<T>(value: unknown, parse: (entry: unknown) => T): readonly T[] { return Array.isArray(value) ? value.map(parse) : fail(); }
function optionalStrings(value: Fields, keys: readonly string[]): void { for (const key of keys) if (value[key] !== undefined) string(value[key]); }
function cost(value: unknown): NonNullable<NativeState['cost']> {
  const result = object(value); finite(result.totalUsd);
  if (result.currency !== 'USD') fail();
  return result as NonNullable<NativeState['cost']>;
}
function requestCost(value: unknown): NativeRequestCost {
  const result = object(value);
  identity(result.turnId); identity(result.rootTurnId);
  if (result.parentTurnId !== undefined) identity(result.parentTurnId);
  const record = object(result.record);
  identity(record.requestId); string(record.provider); string(record.model);
  oneOf(record.serviceTier, ['standard', 'flex', 'batch', 'unknown']);
  oneOf(record.outcome, ['completed', 'failed', 'cancelled']);
  if (record.usdMicros !== undefined) finite(record.usdMicros); // Signed corrections are evidence, not invalid negatives.
  if (record.source !== undefined) oneOf(record.source, ['provider', 'catalog']);
  if (record.unpricedReason !== undefined) oneOf(record.unpricedReason, ['missing_usage', 'unknown_provider', 'unknown_model', 'unknown_tier', 'ambiguous_usage']);
  optionalStrings(record, ['pricingVersion', 'pricedFromProvider']);
  if (record.usage !== undefined) {
    const usage = object(record.usage);
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'prompt_ms', 'completion_ms', 'tokens_per_second', 'ttft_ms'])
      if (usage[key] !== undefined) finite(usage[key]);
    for (const key of ['tokens_per_second_estimated', 'tokens_per_second_burst']) if (usage[key] !== undefined && typeof usage[key] !== 'boolean') fail();
    optionalStrings(usage, ['upstream_provider']);
  }
  return result as NativeRequestCost;
}
function goal(value: unknown): Fields {
  const result = object(value); identity(result.id); string(result.text);
  optionalStrings(result, ['successCriteria']);
  oneOf(result.status, ['active', 'blocked', 'completed', 'cancelled', 'achieved', 'abandoned']);
  return result;
}
function verification(value: unknown): Fields {
  const result = object(value);
  oneOf(result.status, ['pending', 'running', 'passed', 'blocked', 'failed']);
  optionalStrings(result, ['message', 'attemptId', 'revision']);
  if (result.goalGeneration !== undefined) ordinal(result.goalGeneration);
  if (result.report !== undefined) {
    const report = object(result.report);
    oneOf(report.outcome, ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'TIMEOUT']);
    string(report.evidence); string(report.verifierVersion);
    array(report.checked, string); array(report.limitations, string);
  }
  return result;
}
function notice(value: unknown): Fields { const result = object(value); string(result.kind); string(result.message); return result; }
function backgroundNotice(value: unknown): Fields {
  const result = object(value); identity(result.id); string(result.text);
  oneOf(result.kind, ['completion', 'control', 'check_in']); array(result.taskIds, identity);
  return result;
}
function delivery(value: unknown): Fields {
  const result = object(value); identity(result.clientRequestId); identity(result.turnId); array(result.notificationIds, identity);
  return result;
}
/** Upsert one physical receipt, retaining its immutable native ownership.
 * A later complete record replaces the prior record, including corrections/omissions. */
function upsertRequest(previous: readonly NativeRequestCost[], next: NativeRequestCost): readonly NativeRequestCost[] {
  const existing = previous.find(item => item.record.requestId === next.record.requestId);
  if (existing && (existing.turnId !== next.turnId || existing.rootTurnId !== next.rootTurnId || existing.parentTurnId !== next.parentTurnId))
    throw new Term2ProtocolError('Request cost ownership changed');
  return existing ? previous.map(item => item.record.requestId === next.record.requestId ? next : item) : [...previous, next];
}

/** Validate native hydration evidence without defaulting absent fields or converting
 * nulls, zeros or empty arrays to invented values. Also used for branch subsets. */
export function nativeStateFromSnapshot(snapshot: Fields): NativeState {
  const state: NativeState = {};
  if (snapshot.cost !== undefined) state.cost = snapshot.cost === null ? null : cost(snapshot.cost);
  if (snapshot.requestCosts !== undefined) state.requestCosts = array(snapshot.requestCosts, requestCost).reduce<readonly NativeRequestCost[]>((items, item) => upsertRequest(items, item), []);
  if (snapshot.goal !== undefined) state.goal = snapshot.goal === null ? null : goal(snapshot.goal);
  if (snapshot.goalProposal !== undefined) state.goalProposal = snapshot.goalProposal === null ? null : goal(snapshot.goalProposal);
  if (snapshot.goalGeneration !== undefined) state.goalGeneration = ordinal(snapshot.goalGeneration);
  if (snapshot.verification !== undefined) state.verification = snapshot.verification === null ? null : verification(snapshot.verification);
  if (snapshot.notices !== undefined) state.notices = array(snapshot.notices, notice);
  if (snapshot.notifications !== undefined) {
    const notifications = object(snapshot.notifications);
    state.notifications = { notices: array(notifications.notices, backgroundNotice), deliveries: array(notifications.deliveries, delivery) };
  }
  return state;
}

/** Reduce accepted public evidence only; no activity/foreground turn is created
 * for a proposal, a notice, or a silent-turn delivery. Shared v2 owns the allowlist. */
export function applyNativeState(previous: NativeState | undefined, change: AgentChangeV2): NativeState {
  const state = previous ?? {};
  const payload = change.payload;
  switch (change.type) {
    case 'cost': return { ...state, cost: cost(payload) };
    case 'request_cost_recorded': return { ...state, requestCosts: upsertRequest(state.requestCosts ?? [], requestCost(payload)) };
    case 'goal': return { ...state, goal: payload.goal === null ? null : goal(payload.goal), ...(payload.generation === undefined ? {} : { goalGeneration: ordinal(payload.generation) }) };
    case 'goal_proposed': return { ...state, goalProposal: goal(payload.goal) };
    case 'verification': return { ...state, verification: payload.verification === null ? null : verification(payload.verification) };
    case 'notice': return { ...state, notices: [...(state.notices ?? []), notice(payload)] };
    case 'background_notice_enqueued': {
      const next = backgroundNotice(payload.notice);
      const notices = state.notifications?.notices ?? [];
      return { ...state, notifications: { ...state.notifications, notices: notices.some(item => item.id === next.id) ? notices.map(item => item.id === next.id ? next : item) : [...notices, next] } };
    }
    case 'background_notices_delivered': {
      const next = delivery(payload);
      const deliveries = state.notifications?.deliveries ?? [];
      const existing = deliveries.find(item => item.clientRequestId === next.clientRequestId);
      if (existing && existing.turnId !== next.turnId) throw new Term2ProtocolError('Notice delivery ownership changed');
      return { ...state, notifications: { ...state.notifications, deliveries: existing ? deliveries.map(item => item.clientRequestId === next.clientRequestId ? next : item) : [...deliveries, next] } };
    }
    default: throw new Term2ProtocolError('Unsupported native state change');
  }
}
