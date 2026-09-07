/** Extract metrics from a completed cell's conversation, logs, and run_code scripts. */

const DESCRIBE_CALL = /tools\.describe\s*\(/g;
const NESTED_CALL = /tools\.([A-Za-z0-9_]+)\s*\(/g;
const INVALID_PARAMS = /Invalid parameters for "([^"]+)"/g;
const UNKNOWN_TOOL = /Unknown tool "([^"]+)"/g;
const SCHEMA_DIRECT = /Tool input did not match schema for ([A-Za-z0-9_]+)/g;
const CALL_SUMMARY =
  /\[(no tool calls|\d+ tool calls?: [^\];]+?)(?:; (\d+) schema lookups?)?\]/;
const RESULT_FAILURE_PREFIXES = [
  'Error:',
  'Script failed',
  'Script timed out',
  'Script was cancelled',
  'Script exceeded its deadline',
];

export function countMatches(text, regex) {
  const source = regex.flags.includes('g') ? regex : new RegExp(regex.source, regex.flags + 'g');
  return [...String(text).matchAll(source)].length;
}

export function extractNestedCallMetrics(scriptSource, resultText) {
  const code = typeof scriptSource === 'string' ? scriptSource : '';
  const result = typeof resultText === 'string' ? resultText : '';
  const describeLookups = countMatches(code, DESCRIBE_CALL);
  const nestedNames = [];
  for (const match of code.matchAll(NESTED_CALL)) {
    nestedNames.push(match[1]);
  }
  const attemptedNestedCalls = nestedNames.length;
  const attemptedNonDescribe = nestedNames.filter((name) => name !== 'describe').length;
  const invalidParamsAttempted = countMatches(result, INVALID_PARAMS);
  const unknownToolAttempted = countMatches(result, UNKNOWN_TOOL);
  const summary = result.match(CALL_SUMMARY);
  let recordedNestedCalls = null;
  let modelVisibleSchemaLookups = null;
  if (summary) {
    recordedNestedCalls = summary[1] === 'no tool calls' ? 0 : Number(summary[1].split(' ')[0]);
    modelVisibleSchemaLookups = summary[2] != null ? Number(summary[2]) : null;
  }
  // describe is not recorded. invalid_params/unknown_tool are recorded but not admitted.
  // Admitted count is therefore not recoverable from the user-visible summary alone.
  const admittedNestedCallsKnown = false;
  const admittedNestedCalls = null;
  const scriptFailed = RESULT_FAILURE_PREFIXES.some((prefix) => result.startsWith(prefix));
  return {
    describeLookups,
    attemptedNestedCalls,
    attemptedNonDescribe,
    invalidParamsAttempted,
    unknownToolAttempted,
    recordedNestedCalls,
    modelVisibleSchemaLookups,
    admittedNestedCallsKnown,
    admittedNestedCalls,
    scriptFailed,
  };
}

export function extractRunCodeSources(events) {
  const scripts = [];
  const results = [];
  for (const event of events) {
    if (event.type === 'tool_started' && event.toolName === 'run_code') {
      const args = event.arguments;
      const code = args && typeof args === 'object' ? args.code : typeof args === 'string' ? args : '';
      scripts.push(typeof code === 'string' ? code : '');
    }
    if (event.type === 'command_message' && event.message?.toolName === 'run_code') {
      results.push(typeof event.message?.output === 'string' ? event.message.output : '');
    }
    if (event.type === 'tool_result' && event.toolName === 'run_code') {
      if (typeof event.output === 'string') results.push(event.output);
    }
  }
  return { scripts, results };
}

const TREATED_NONESSENTIAL = new Set([
  'memory_list',
  'memory_get',
  'memory_search',
  'memory_retrieve',
  'memory_synthesize',
  'memory_create',
  'memory_update',
  'memory_delete',
  'activate_skill',
  'configure_task_check_in',
  'web_search',
  'web_fetch',
  'get_subagent_result',
  'get_subagent_status',
  'send_message',
  'cancel_run',
]);

export function extractTreatedToolPath(events) {
  const { scripts, results } = extractRunCodeSources(events);
  const nested = [];
  for (const script of scripts) {
    for (const match of String(script).matchAll(NESTED_CALL)) {
      if (match[1] !== 'describe') nested.push(match[1]);
    }
  }
  const treated = nested.filter((name) => TREATED_NONESSENTIAL.has(name));
  return {
    nestedToolCalls: nested,
    treatedToolCalls: treated,
    usedTreatedTool: treated.length > 0,
    usedEssentialBypassOnly: nested.length > 0 && treated.length === 0,
    scriptCount: scripts.length,
    resultCount: results.length,
  };
}

export function extractSessionIdentity(events) {
  const init = events.find((event) => event.type === 'session_init') ?? {};
  const cost = events.find((event) => event.type === 'cost_update' && event.record?.provider);
  const finalEvent = events.find((event) => event.type === 'final' && Array.isArray(event.costRecords));
  const record = cost?.record ?? finalEvent?.costRecords?.[0] ?? {};
  const provider =
    (typeof init.provider === 'string' && init.provider) ||
    (typeof record.provider === 'string' && record.provider) ||
    null;
  const model =
    (typeof init.model === 'string' && init.model) || (typeof record.model === 'string' && record.model) || null;
  return {
    sessionId: typeof init.id === 'string' ? init.id : null,
    provider,
    model,
    reasoningEffort: typeof init.reasoningEffort === 'string' ? init.reasoningEffort : null,
    projectPath: typeof init.projectPath === 'string' ? init.projectPath : null,
    identitySource: init.provider || init.model ? 'session_init' : provider ? 'cost_update' : 'missing',
  };
}

export function matchIdentity(identity, pin) {
  if (!identity?.provider || !identity?.model) {
    return { present: false, ok: false, reason: 'identity-missing' };
  }
  if (identity.provider !== pin.provider || identity.model !== pin.model) {
    return { present: true, ok: false, reason: 'wrong-model' };
  }
  if (pin.reasoningEffort && identity.reasoningEffort && identity.reasoningEffort !== pin.reasoningEffort) {
    return { present: true, ok: false, reason: 'wrong-model' };
  }
  return { present: true, ok: true, reason: 'identity-match' };
}

export function extractUsage(events) {
  const costs = events.filter((event) => event.type === 'cost_update' && event.record?.usage);
  if (costs.length > 0) {
    const perTurnPromptTokens = costs.map((event) =>
      typeof event.record.usage.prompt_tokens === 'number' ? event.record.usage.prompt_tokens : null,
    );
    const perTurnCacheReadTokens = costs.map((event) =>
      typeof event.record.usage.cache_read_tokens === 'number' ? event.record.usage.cache_read_tokens : null,
    );
    let costUsdMicros = 0;
    let costKnown = false;
    for (const event of costs) {
      if (typeof event.record.usdMicros === 'number') {
        costUsdMicros += event.record.usdMicros;
        costKnown = true;
      }
    }
    const last = costs[costs.length - 1]?.record?.usage ?? null;
    return {
      turnCount: costs.length,
      perTurnPromptTokens,
      perTurnCacheReadTokens,
      promptTokensSum: sumKnown(perTurnPromptTokens),
      cacheReadTokensSum: sumKnown(perTurnCacheReadTokens),
      lastUsage: last,
      costUsdMicros: costKnown ? costUsdMicros : null,
      costKnown,
      usageSource: 'cost_update',
    };
  }
  const turns = events.filter((event) => event.type === 'assistant_turn');
  const perTurnPromptTokens = [];
  const perTurnCacheReadTokens = [];
  let lastUsage = null;
  let costUsdMicros = null;
  let costKnown = false;
  for (const turn of turns) {
    const usage = turn.usage ?? turn.displayUsage ?? null;
    if (usage && typeof usage.prompt_tokens === 'number') {
      perTurnPromptTokens.push(usage.prompt_tokens);
    } else {
      perTurnPromptTokens.push(null);
    }
    if (usage && typeof usage.cache_read_tokens === 'number') {
      perTurnCacheReadTokens.push(usage.cache_read_tokens);
    } else {
      perTurnCacheReadTokens.push(null);
    }
    lastUsage = usage ?? lastUsage;
    if (Array.isArray(turn.costRecords)) {
      for (const record of turn.costRecords) {
        if (record && typeof record.usdMicros === 'number') {
          costUsdMicros = (costUsdMicros ?? 0) + record.usdMicros;
          costKnown = true;
        }
      }
    }
  }
  const finalEvent = events.find((event) => event.type === 'final' && event.usage);
  if (turns.length === 0 && finalEvent?.usage) {
    const usage = finalEvent.usage;
    return {
      turnCount: 1,
      perTurnPromptTokens: [typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null],
      perTurnCacheReadTokens: [typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : null],
      promptTokensSum: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
      cacheReadTokensSum: typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : null,
      lastUsage: usage,
      costUsdMicros: null,
      costKnown: false,
      usageSource: 'final',
    };
  }
  return {
    turnCount: turns.length,
    perTurnPromptTokens,
    perTurnCacheReadTokens,
    promptTokensSum: sumKnown(perTurnPromptTokens),
    cacheReadTokensSum: sumKnown(perTurnCacheReadTokens),
    lastUsage,
    costUsdMicros: costKnown ? costUsdMicros : null,
    costKnown,
    usageSource: 'assistant_turn',
  };
}

function sumKnown(values) {
  const known = values.filter((value) => typeof value === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

export function extractDirectSchemaFailures(events) {
  let count = 0;
  for (const event of events) {
    const output =
      event.type === 'command_message' && typeof event.message?.output === 'string'
        ? event.message.output
        : event.type === 'tool_result' && typeof event.output === 'string'
          ? event.output
          : '';
    count += countMatches(output, SCHEMA_DIRECT);
  }
  return count;
}

export function extractResultHandling(events) {
  const { scripts, results } = extractRunCodeSources(events);
  let failures = 0;
  let recoveries = 0;
  for (let index = 0; index < results.length; index += 1) {
    const metrics = extractNestedCallMetrics(scripts[index] ?? '', results[index]);
    if (metrics.scriptFailed || metrics.invalidParamsAttempted > 0 || metrics.unknownToolAttempted > 0) {
      failures += 1;
      const laterSuccess = results.slice(index + 1).some((text) => {
        const later = extractNestedCallMetrics('', text);
        return !later.scriptFailed && later.invalidParamsAttempted === 0 && later.unknownToolAttempted === 0;
      });
      if (laterSuccess) recoveries += 1;
    }
  }
  return { resultHandlingFailures: failures, resultHandlingRecoveries: recoveries, runCodeCalls: results.length };
}

export function extractCellMetrics({ events, wallTimeMs, headerSnapshot }) {
  const identity = extractSessionIdentity(events);
  const usage = extractUsage(events);
  const { scripts, results } = extractRunCodeSources(events);
  const nested = scripts.map((script, index) => extractNestedCallMetrics(script, results[index] ?? ''));
  const handling = extractResultHandling(events);
  const describeLookups = nested.reduce((sum, row) => sum + row.describeLookups, 0);
  const invalidParamsAttempted = nested.reduce((sum, row) => sum + row.invalidParamsAttempted, 0);
  const unknownToolAttempted = nested.reduce((sum, row) => sum + row.unknownToolAttempted, 0);
  const recordedNestedCalls = nested.reduce((sum, row) => sum + (row.recordedNestedCalls ?? 0), 0);
  const modelVisibleSchemaLookups = nested.reduce((sum, row) => {
    return sum + (typeof row.modelVisibleSchemaLookups === 'number' ? row.modelVisibleSchemaLookups : 0);
  }, 0);
  const modelVisibleSchemaLookupsPresent = nested.some((row) => row.modelVisibleSchemaLookups != null);
  return {
    identity,
    usage,
    headerSnapshot: headerSnapshot ?? null,
    describeLookups,
    invalidParamsAttempted,
    unknownToolAttempted,
    directSchemaFailures: extractDirectSchemaFailures(events),
    recordedNestedCalls,
    describeLookupsFromScript: describeLookups,
    modelVisibleSchemaLookups: modelVisibleSchemaLookupsPresent ? modelVisibleSchemaLookups : null,
    admittedNestedCallsKnown: false,
    admittedNestedCalls: null,
    admittedNestedNote:
      'describe lookups are not recorded; invalid_params and unknown_tool are recorded but not admitted. Admitted executions are not separately visible in conversation output.',
    ...handling,
    wallTimeMs: typeof wallTimeMs === 'number' ? wallTimeMs : null,
    toolStarted: events.filter((event) => event.type === 'tool_started').map((event) => event.toolName),
  };
}

export function modelMatchesPin(identity, pin) {
  return matchIdentity(identity, pin).ok;
}
