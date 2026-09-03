#!/usr/bin/env node
// Luna tool-FORMAT paired experiment + reproducible-trigger gauge.
//
// Paired design: same model (gpt-5.6-luna), same patch content, same history
// length. Arm A = OUR apply_patch schema (patch body as a direct `diff`
// JSON string parameter, whitespace-semantic update hunks). Arm B = Codex
// shape (single `exec` tool whose argument is a JS program calling nested
// tools.apply_patch with a *** Update File *** script).
// Primary metric: WHITESPACE-RUN ONSET per probe — max consecutive
// whitespace run, offset where content stops, ws fraction (computed
// automatically by wsStats, never eyeballed). Size is downstream of that.
//
// Usage:
//   node scripts/experiments/luna-format-repro/luna-format-repro.mjs [nProbes] [outPath] [wsFireThreshold]
//   FORMAT_N_HISTORY=10  history turns per arm (default 10)
//   CANONICAL_DIFF=canonical  arm A advertises/seeds the canonical envelope (post-change); default legacy (baseline)
//   FORMAT_N_HISTORY=10  history turns per arm (default 10)
//   CODEX_TOKEN=...      bearer token (default: read-only from ~/.codex/auth.json)
//   CODEX_BASE_URL=...   endpoint override (default: chatgpt.com codex backend)
//
// A probe FIRES when maxWsRun >= WS_FIRE_THRESHOLD (default 10000 chars:
// production runaways show 40k-99k; clean probes show single digits).
// Exit code: 0 = all clean, 1 = >=1 probe fired, 2 = harness error.
// Result JSON: { config, fireThreshold, arms: { A: {toolName,
// historyModelCalls, fired, n, probes[]}, B: {...} }, sentInputChars }.
//
// Cost: ~20 history calls + 2*nProbes probe calls per run (full-history
// replay, so later calls resend the accumulated input). The v2 full run
// (10-turn history, 4 probes/arm) sent ~246k input chars. Keep nProbes
// small; stop if spend balloons. Direct Codex Responses endpoint — NOT the
// production app; token is read-only, never logged or written.
import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
function loadToken() {
  const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
  const t = raw.tokens ?? raw;
  if (!t?.access_token) throw new Error('no access_token in ~/.codex/auth.json');
  return t.access_token;
}
const TOKEN = process.env.CODEX_TOKEN || loadToken();

const MODEL = 'gpt-5.6-luna';
if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.log('usage: node luna-format-repro.mjs [nProbes] [outPath] [wsFireThreshold]\nHistoria: FORMAT_N_HISTORY (default 10). No API call is made with --help.');
  process.exit(0);
}
const N_HISTORY = Number(process.env.FORMAT_N_HISTORY || 10);
const N_PROBES = Number(process.argv[2] || 4);
const MAX_ARG_CHARS = 100_000;
const ARM_TIMEOUT_MS = 180_000;
const OUT_PATH = process.argv[3] || '/tmp/luna-format-repro/format2.json';
// A probe FIRES at >=10k consecutive whitespace chars: production runaways
// show 40k-99k, clean v2 probes showed max 5. Threshold is a CLI override.
const WS_FIRE_THRESHOLD = Number(process.argv[4] || 10_000);

const HEADERS = {
  'authorization': `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  'originator': 'codex_exec',
  'openai-beta': 'responses_websockets=2026-02-06',
  'x-openai-internal-codex-responses-lite': 'true',
};

let sentInputChars = 0;

// Whitespace-semantic update patch: space-prefixed context lines, indentation
// significant — the production update_file runaway shape (7/17 aborted).
function tsDiff(i) {
  return [
    '@@ method assessLiveness',
    ' export const assessBackgroundTaskLiveness = ({',
    '   tasks,',
    '   thresholds,',
    `   taskKind${i},`,
    ' }: {',
    '   tasks: BackgroundTask[];',
    '   thresholds: LivenessThresholds;',
    ' }) => {',
    `-  return tasks.filter((t) => t.status === 'running');`,
    `+  return tasks.filter((t) => t.status === 'running' && !t.cancelled${i});`,
    ' };',
    '@@ method describeStatus',
    ` export function describeStatus${i}(t: BackgroundTask): string {`,
    `+  if (t.cancelled${i}) return 'cancelled';`,
    "   return t.status;",
    ' }',
  ].join('\n');
}
// Same patch content in upstream *** Update File *** script form (Codex shape).
function patchScript(i, target) {
  return ['*** Begin Patch', `*** Update File: ${target}`,
    ...tsDiff(i).split('\n'), '*** End Patch'].join('\n');
}
function execProgram(i, target) {
  return `const patch = ${JSON.stringify(patchScript(i, target))};\ntext(await tools.apply_patch(patch));`;
}

const TARGET = 'source/services/background-task-activity.ts';

// Our apply_patch schema: patch body is a direct JSON string parameter.
// CANONICAL-DIFF is a CLI override for the before/after gauge: when set to
// 'canonical', arm A advertises and seeds the canonical *** Begin Patch ***
// envelope (the post-change shape); otherwise it uses the legacy headerless
// diff (the pre-change baseline). Arm B (exec program) is unchanged in both.
const CANONICAL_DIFF = (process.env.CANONICAL_DIFF || '').toLowerCase() === 'canonical';
const APPLY_PATCH_DESCRIPTION = CANONICAL_DIFF
  ? 'Apply file changes with a patch script. Write the patch directly — no JSON escaping of the body. Format: *** Begin Patch, then one section per file (*** Add File: <path> with + lines; *** Update File: <path> with space/+/- lines and @@ anchors, *** Move to: <new-path> to move; *** Delete File: <path>), then *** End Patch. Context lines start with a SPACE; match indentation exactly.'
  : 'Apply file changes using headerless V4A diff format. Each line MUST start with exactly one character: space (context), + (added), or - (removed). Context lines start with a SPACE character and indentation must match the target file exactly.';
const APPLY_PATCH_DECL = {
  type: 'function', name: 'apply_patch',
  description: APPLY_PATCH_DESCRIPTION,
  parameters: { type: 'object', properties: {
    type: { type: 'string' }, path: { type: 'string' },
    moveTo: { type: ['string', 'null'] }, diff: { type: 'string' },
  }, required: ['type', 'path', 'diff'] },
};
const EXEC_DECL = {
  type: 'function', name: 'exec',
  description: 'Run a JavaScript program with tool capabilities. Inside the program call await tools.exec_command({cmd, workdir}) to run shell commands and await tools.apply_patch(patch) to write files, where patch is a *** Begin Patch *** script using *** Add File: <path> to create files and *** Update File: <path> to edit them (context lines start with a space, added lines with +, removed with -, indentation must match the target exactly). Finish by passing the result to text(value). The argument must be one self-contained program.',
  parameters: { type: 'object', properties: {
    program: { type: 'string' },
  }, required: ['program'] },
};

const TOOLS_PREFIX = (tools) => [{ type: 'additional_tools', role: 'developer', tools }];

const BIG_ASK_A = `Apply an update_file patch to ${TARGET}: refactor assessBackgroundTaskLiveness and describeStatus plus the five neighbouring helpers (isStale, heartbeatAge, watchThreshold, pruneCancelled, summarizeLiveness) to thread a new LivenessOptions parameter through every signature, keeping all existing context lines space-prefixed and every indentation level exact. Emit the full multi-hunk diff in one apply_patch call.`;
const BIG_ASK_B = `Via exec, in THIS SINGLE call with no prior reads: build a *** Begin Patch *** script with *** Update File: ${TARGET} that refactors assessBackgroundTaskLiveness and describeStatus plus the five neighbouring helpers (isStale, heartbeatAge, watchThreshold, pruneCancelled, summarizeLiveness) to thread a new LivenessOptions parameter through every signature, keeping all existing context lines space-prefixed and every indentation level exact. Do NOT call tools.exec_command and do NOT read the file — emit the complete patch program now with await tools.apply_patch(patch), then pass the result to text().`; 

const FORMATS = {
  A: { decl: APPLY_PATCH_DECL, toolName: 'apply_patch',
    argFor: (i) => CANONICAL_DIFF
      ? JSON.stringify({ type: 'update_file', path: TARGET, moveTo: null, diff: patchScript(i, TARGET) })
      : JSON.stringify({ type: 'update_file', path: TARGET, moveTo: null, diff: tsDiff(i) }),
    outputFor: (i) => `Updated background-task-activity.ts (hunk ${i})`,
    seedAsk: (i) => CANONICAL_DIFF
      ? `Apply a *** Update File: ${TARGET} *** patch section (hunk ${i}: thread taskKind${i} through assessBackgroundTaskLiveness, keep context lines space-prefixed and indentation exact) inside a *** Begin Patch *** / *** End Patch *** envelope.`
      : `Apply an update_file patch to ${TARGET} (hunk ${i}: thread taskKind${i} through assessBackgroundTaskLiveness, keep context lines space-prefixed and indentation exact).`,
    intro: CANONICAL_DIFF
      ? 'Apply *** Update File *** patch sections to source/services/background-task-activity.ts via apply_patch inside a *** Begin Patch *** envelope, one hunk per turn. Context lines start with a space; indentation must match exactly.'
      : 'Apply update_file patches to source/services/background-task-activity.ts via apply_patch, one hunk per turn. Context lines start with a space; indentation must match exactly.',
    finalAsk: CANONICAL_DIFF
      ? `Apply a *** Begin Patch *** envelope to ${TARGET}: a *** Update File *** section refactoring assessBackgroundTaskLiveness and describeStatus plus the five neighbouring helpers (isStale, heartbeatAge, watchThreshold, pruneCancelled, summarizeLiveness) to thread a new LivenessOptions parameter through every signature, keeping all existing context lines space-prefixed and every indentation level exact. Emit the full multi-hunk envelope in one apply_patch call.`
      : BIG_ASK_A },
  B: { decl: EXEC_DECL, toolName: 'exec',
    argFor: (i) => JSON.stringify({ program: execProgram(i, TARGET) }),
    outputFor: (i) => `Applied patch hunk ${i} to background-task-activity.ts`,
    seedAsk: (i) => `Via exec, apply a *** Update File: ${TARGET} *** script (hunk ${i}: thread taskKind${i} through assessBackgroundTaskLiveness, keep context lines space-prefixed and indentation exact) with await tools.apply_patch(patch).`,
    intro: 'Apply *** Update File *** patches to source/services/background-task-activity.ts via exec programs that call tools.apply_patch, one hunk per turn. Context lines start with a space; indentation must match exactly.',
    finalAsk: BIG_ASK_B },
};

async function create(body) {
  sentInputChars += JSON.stringify(body).length;
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ stream: true, store: false, ...body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function collectFull(res, timeoutMs = 90_000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', id = null, outText = '', calls = [], done = false;
  const t0 = Date.now();
  try {
    for (;;) {
      if (Date.now() - t0 > timeoutMs) throw new Error('collect timeout');
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (!m) continue;
        let ev; try { ev = JSON.parse(m[1]); } catch { continue; }
        if (ev.type === 'response.created' && ev.response?.id) id = ev.response.id;
        else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') calls.push({ id: ev.item.call_id, name: ev.item.name });
        else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') outText += ev.delta;
        else if (ev.type === 'response.completed') { done = true; if (ev.response?.id) id = ev.response.id; }
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error('history step failed: ' + JSON.stringify(ev).slice(0, 300));
        if (done) break;
      }
      if (done) break;
    }
  } finally { try { reader.cancel(); } catch {} }
  if (!id) throw new Error('no response id in stream');
  return { id, outText, calls };
}

async function buildHistory(fmtKey) {
  const F = FORMATS[fmtKey];
  const input = [...TOOLS_PREFIX([F.decl]),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: F.intro }] }];
  let modelCalls = 0;
  for (let i = 0; i < N_HISTORY; i++) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: F.seedAsk(i) }] });
    const body = { model: MODEL, input: [...input], instructions: '',
      parallel_tool_calls: false, reasoning: { effort: 'high', summary: 'auto', context: 'all_turns' },
      client_metadata: { 'x-openai-internal-codex-responses-lite': 'true' } };
    const res = await create(body);
    const got = await collectFull(res);
    modelCalls += got.calls.length;
    const stepCall = got.calls.length ? got.calls[got.calls.length - 1].id : `call_repro_synth_${fmtKey}_${i}`;
    input.push({ type: 'function_call', call_id: stepCall, name: F.toolName, arguments: F.argFor(i) });
    input.push({ type: 'function_call_output', call_id: stepCall, output: F.outputFor(i) });
    console.log(`history ${fmtKey}${i}: model-call=${got.calls.length} name=${got.calls.length ? got.calls[got.calls.length - 1].name : '(synth)'}`);
  }
  return { input, modelCalls };
}

function wsStats(arg) {
  let maxRun = 0, run = 0, lastNonWs = -1, wsChars = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      run++; wsChars++;
      if (run > maxRun) maxRun = run;
    } else { run = 0; lastNonWs = i; }
  }
  return { maxWsRun: maxRun, contentEnd: lastNonWs, wsFrac: arg.length ? wsChars / arg.length : 0 };
}

async function runProbe(fmtKey, hist) {
  const F = FORMATS[fmtKey];
  const input = [...hist,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: F.finalAsk }] }];
  const body = { model: MODEL, input,
    instructions: '', parallel_tool_calls: false,
    reasoning: { effort: 'high', summary: 'auto', context: 'all_turns' },
    client_metadata: { 'x-openai-internal-codex-responses-lite': 'true' } };
  const res = await create(body);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', arg = '', frames = 0, done = false, completed = false;
  const t0 = Date.now();
  const timer = setTimeout(() => { try { reader.cancel(); } catch {} }, ARM_TIMEOUT_MS);
  try {
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (!m) continue;
        let ev; try { ev = JSON.parse(m[1]); } catch { continue; }
        if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
          arg += ev.delta; frames++;
        } else if (ev.type === 'response.completed') { completed = true; done = true; }
        else if (ev.type === 'response.failed' || ev.type === 'error') { done = true; }
        if (arg.length >= MAX_ARG_CHARS) { done = true; }
        if (done) break;
      }
      if (done) break;
      if (Date.now() - t0 > ARM_TIMEOUT_MS) break;
    }
  } finally { clearTimeout(timer); try { reader.cancel(); } catch {} }
  const ws = wsStats(arg);
  const fired = ws.maxWsRun >= WS_FIRE_THRESHOLD;
  return { model: MODEL, format: fmtKey, argChars: arg.length, frames,
    charsPerFrame: frames ? +(arg.length / frames).toFixed(2) : 0,
    completed, ms: Date.now() - t0, killedAtCap: arg.length >= MAX_ARG_CHARS,
    fired,
    ...ws, head: arg.slice(0, 200), tailSample: arg.slice(-80) };
}

const out = { config: { model: MODEL, nHistory: N_HISTORY, nProbes: N_PROBES, maxArgChars: MAX_ARG_CHARS, canonicalDiff: CANONICAL_DIFF }, fireThreshold: WS_FIRE_THRESHOLD, arms: {} };
let anyFired = false;
let errored = false;
try {
for (const fmtKey of ['A', 'B']) {
  console.log(`--- building format-${fmtKey} history (${FORMATS[fmtKey].toolName})`);
  const { input: hist, modelCalls } = await buildHistory(fmtKey);
  const probes = [];
  for (let k = 0; k < N_PROBES; k++) {
    console.log(`--- probe ${fmtKey}${k}`);
    const r = await runProbe(fmtKey, hist);
    const { head, tailSample, ...rest } = r;
    console.log(JSON.stringify({ ...rest, head: head.slice(0, 120) }));
    probes.push(r);
    if (r.fired) anyFired = true;
  }
  const fired = probes.filter((p) => p.fired).length;
  out.arms[fmtKey] = { toolName: FORMATS[fmtKey].toolName, historyModelCalls: modelCalls, fired, n: probes.length, probes };
}
} catch (err) {
  errored = true;
  out.error = String(err && err.message ? err.message : err).slice(0, 300);
  console.error('harness error:', out.error);
}
out.sentInputChars = sentInputChars;
writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT_PATH} sentInputChars=${sentInputChars} fired=${anyFired}`);
process.exit(errored ? 2 : anyFired ? 1 : 0);
