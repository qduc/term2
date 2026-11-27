/**
 * Which settings a paired web client may read and change through the gateway, and the value
 * shapes those writes may carry. The gateway refuses every other key; the settings schema
 * still validates each accepted value before it is stored.
 */

export type WebSettingRule = {
  /** Applies to the chat being configured rather than to new chats. */
  readonly session?: true;
  /** Read-only from the web: shown, never written. */
  readonly readOnly?: true;
  /** The web asks before saving a non-reset value (it can widen what commands may do or cost). */
  readonly confirm?: true;
  /**
   * A list the web may only shorten: it can revoke a grant, never add one. Only for lists whose
   * default is empty, since a reset (revoking everything) is allowed too.
   */
  readonly revokeOnly?: true;
  /** The stored key, when the web uses a different name for it. */
  readonly storedAs?: string;
};

const SESSION: WebSettingRule = { session: true };
const CONFIRM: WebSettingRule = { confirm: true };

export const WEB_SETTINGS: Readonly<Record<string, WebSettingRule>> = {
  'agent.modelSelection': SESSION,
  'agent.reasoningEffort': SESSION,
  'agent.temperature': {},
  'agent.maxTurns': {},
  'agent.maxOutputTokens': {},
  'agent.maxStreamOutputChars': {},
  'agent.maxModelRequestDurationMs': {},
  'agent.retryAttempts': {},
  'agent.maxParallelToolCalls': CONFIRM,
  'agent.runBudget.maxUsdMicros': CONFIRM,
  'agent.runBudget.maxActiveTimeMs': CONFIRM,
  'agent.runBudget.maxUnpricedTokens': CONFIRM,
  'agent.runBudget.escalation': CONFIRM,
  'agent.contextCompaction.enabled': {},
  'agent.contextCompaction.threshold': { storedAs: 'agent.contextCompaction.compactThreshold' },
  'agent.contextCompaction.mode': {},
  'agent.sessionRollover.enabled': {},
  'agent.sessionRollover.autoBrief': {},
  'app.activeProfileId': { session: true, readOnly: true },
  'app.mentorMode': { session: true, readOnly: true },
  'app.liteMode': SESSION,
  'app.planMode': { session: true, readOnly: true },
  'app.orchestratorMode': { session: true, readOnly: true },
  'webSearch.provider': {},
  'webSearch.firecrawl.baseUrl': {},
  'webSearch.searxng.baseUrl': {},
  'memory.enabled': {},
  'memory.directory': CONFIRM,
  'logging.logLevel': {},
  'shell.autoApproveMode': { session: true, confirm: true },
  'shell.showReview': { session: true, confirm: true },
  'shell.unattendedEscapeReview': CONFIRM,
  'shell.timeout': CONFIRM,
  'shell.backgroundTimeout': CONFIRM,
  'shell.maxOutputLines': CONFIRM,
  'tools.maxOutputChars': {},
  'sandbox.enabled': CONFIRM,
  'sandbox.readPolicy': CONFIRM,
  'sandbox.allowNetworking': CONFIRM,
  'sandbox.dockerHostControlProjects': { revokeOnly: true },
  'tools.shell.enabled': {},
  'tools.fileRead.enabled': {},
  'tools.fileWrite.enabled': {},
  'tools.web.enabled': {},
  'tools.memory.enabled': {},
  'tools.sessions.enabled': {},
  'tools.skills.enabled': {},
  'tools.subagents.enabled': {},
  'tools.backgroundTasks.enabled': {},
  'tools.mentor.enabled': {},
  'tools.userInteraction.enabled': {},
  'tools.codeContext.enabled': {},
  enable_agent_workflow: {},
  'agent.completionVerification': {},
  'agent.backgroundCheckIn.enabled': {},
  'agent.backgroundCheckIn.intervalMs': {},
  'agent.favoriteModels': {},
  'agent.modelNicknames': {},
  'verifier.model': {},
  'agent.smartModel': {},
  'agent.smartReasoningEffort': {},
  'agent.balancedModel': {},
  'agent.balancedReasoningEffort': {},
  'agent.cheapModel': {},
  'agent.cheapReasoningEffort': {},
  'agent.choreModel': {},
  'agent.mentorPool': {},
  'agent.useFlexServiceTier': {},
};

export type WebModelSelection = { model: string; provider: string; reasoningEffort?: string };
export type WebSettingValue =
  | string
  | number
  | boolean
  | readonly string[]
  | WebModelSelection
  | readonly WebModelSelection[]
  | Readonly<Record<string, string>>
  | null;

const MAX_ITEMS = 256;
const MAX_TEXT = 2_048;

const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max;

function selection(value: unknown): WebModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'model' && key !== 'provider' && key !== 'reasoningEffort')) return undefined;
  if (!text(record.model, 512) || !record.model.trim() || !text(record.provider, 256) || !record.provider.trim())
    return undefined;
  if (record.reasoningEffort !== undefined && !text(record.reasoningEffort, 32)) return undefined;
  return {
    model: record.model.trim(),
    provider: record.provider.trim(),
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
  };
}

/**
 * The value as the web may see or send it, or `undefined` when its shape is not one the web
 * handles: a scalar, a list of strings, a model selection, a list of model selections, or a
 * map of short strings (model nicknames).
 */
export function webSettingValue(value: unknown): WebSettingValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= MAX_TEXT ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) return undefined;
    if (value.every((item) => text(item))) return [...(value as string[])];
    const selections = value.map(selection);
    return selections.every((item) => item !== undefined) ? (selections as WebModelSelection[]) : undefined;
  }
  if (typeof value !== 'object') return undefined;
  const single = selection(value);
  if (single) return single;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ITEMS || !entries.every(([key, item]) => text(key, 256) && text(item, 1_024)))
    return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** A revoke-only list write may keep or drop current entries, or reset to empty, but never add one. */
export function onlyRevokes(current: unknown, next: unknown): boolean {
  if (next === null) return true;
  if (!Array.isArray(next)) return false;
  const kept = new Set(Array.isArray(current) ? current.map((item) => JSON.stringify(item)) : []);
  return next.every((item) => kept.has(JSON.stringify(item)));
}
