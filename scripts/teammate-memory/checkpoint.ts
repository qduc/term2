import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
  StreamedModelUsage,
} from '../../source/contracts/streamed-model-turn.js';

type Arm = 'A' | 'B';
type Preflight = {
  valid: boolean;
  snapshot: string;
  model: string;
  aContext: string;
  bContext: string;
};

const QUESTION =
  'The nested Codex 400s are back. What is the smallest next diagnostic and what should we avoid changing?';
const SHARED_INSTRUCTIONS = `You are assisting with a returning engineering question. Use earlier project memory only when it is supported by the provided summaries; otherwise state what you do not know. Distinguish an earlier decision from new wire evidence. This is a single-turn, tool-free recall probe; do not claim to have inspected logs or changed code.\n\nPersistent memory summaries (potentially incomplete):\n`;
const MAX_INPUT_BYTES = 32_000;
const MAX_OUTPUT_TOKENS = 128_000; // Published physical gpt-6-luna limit, not a Codex request parameter.
const INPUT_PRICE_PER_M = 0.125; // Worst input/cache-write rate below the 272K-token tier.
const OUTPUT_PRICE_PER_M = 0.5;
const TOKEN_OVERHEAD = 1024; // Conservative allowance for provider-generated envelope tokens.

export type CheckpointRequest = {
  arm: Arm;
  request: StreamedModelTurnRequest;
  maxReferenceUsd: number;
  promptSha256: string;
};

export type CheckpointResult = {
  arm: Arm;
  promptSha256: string;
  text: string;
  usage: StreamedModelUsage;
  responseId: string;
  maxReferenceUsd: number;
};

/** Provider errors can carry response headers (including cookies); never render the error object. */
export function formatCheckpointError(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    return `Checkpoint stopped: provider HTTP ${status}; no retry attempted.`;
  }
  return 'Checkpoint stopped: request failed; no retry attempted.';
}

export function buildCheckpointPair(preflight: Preflight): [CheckpointRequest, CheckpointRequest] {
  if (!preflight.valid || preflight.snapshot !== 'a1142650') throw new Error('R1 preflight is invalid');
  if (preflight.model !== 'codex/gpt-6-luna') throw new Error('Unexpected pilot model');
  if (!preflight.aContext || !preflight.bContext || preflight.aContext === preflight.bContext) {
    throw new Error('Missing A/B memory contrast');
  }
  const make = (arm: Arm, context: string): CheckpointRequest => {
    const instructions = `${SHARED_INSTRUCTIONS}${context}`;
    const input = [
      { type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: QUESTION }] },
    ];
    const bytes = Buffer.byteLength(instructions, 'utf8') + Buffer.byteLength(QUESTION, 'utf8');
    if (bytes > MAX_INPUT_BYTES) throw new Error('Checkpoint input exceeds the admission bound');
    return {
      arm,
      request: { instructions, input, tools: [], toolChoice: 'none', reasoning: { effort: 'medium' } },
      // This is an API-list-price equivalent, NOT a guarantee of Codex subscription billing.
      maxReferenceUsd:
        ((MAX_INPUT_BYTES + TOKEN_OVERHEAD) * INPUT_PRICE_PER_M + MAX_OUTPUT_TOKENS * OUTPUT_PRICE_PER_M) / 1_000_000,
      promptSha256: createHash('sha256').update(JSON.stringify({ instructions, input })).digest('hex'),
    };
  };
  return [make('A', preflight.aContext), make('B', preflight.bContext)];
}

export async function runCheckpointPair(
  pair: [CheckpointRequest, CheckpointRequest],
  deps: {
    createModel: (arm: Arm) => Promise<Pick<StreamedModelTurn, 'stream'>>;
    persist: (result: CheckpointResult) => Promise<void>;
  },
): Promise<CheckpointResult[]> {
  const results: CheckpointResult[] = [];
  for (const { arm, request, maxReferenceUsd, promptSha256 } of pair) {
    const model = await deps.createModel(arm);
    let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
    for await (const event of model.stream(request)) {
      if (event.type === 'tool_call') throw new Error('Unexpected tool call: checkpoint cannot continue safely');
      if (event.type === 'context_compaction_started' || event.type === 'context_compaction_completed') {
        throw new Error('Unexpected compaction: checkpoint cannot continue safely');
      }
      if (event.type === 'completion') {
        if (completion) throw new Error('Multiple completions: checkpoint cannot continue safely');
        completion = event;
      }
    }
    if (
      !completion ||
      !completion.usage ||
      !Number.isSafeInteger(completion.usage.inputTokens) ||
      !Number.isSafeInteger(completion.usage.outputTokens) ||
      completion.usage.inputTokens! < 0 ||
      completion.usage.outputTokens! < 0
    ) {
      throw new Error('Missing or invalid provider usage: stop before another request');
    }
    if (
      completion.usage.inputTokens! > MAX_INPUT_BYTES + TOKEN_OVERHEAD ||
      completion.usage.outputTokens! > MAX_OUTPUT_TOKENS
    ) {
      throw new Error('Provider usage exceeded the reserved envelope: stop before another request');
    }
    const text = completion.output
      .flatMap((item) => (item.type === 'message' ? item.content.map((part) => part.text) : []))
      .join('');
    if (!text.trim() || completion.output.some((item) => item.type === 'tool_call')) {
      throw new Error('No final answer or unexpected tool call: stop before another request');
    }
    const result = {
      arm,
      promptSha256,
      text,
      usage: completion.usage,
      responseId: completion.responseId,
      maxReferenceUsd,
    };
    await deps.persist(result);
    results.push(result);
  }
  return results;
}

async function main() {
  const [directory, flag] = process.argv.slice(2);
  if (!directory || (flag && flag !== '--go')) throw new Error('Usage: checkpoint.ts <preflight-directory> [--go]');
  const root = resolve(directory);
  const preflight = JSON.parse(await readFile(join(root, 'preflight.json'), 'utf8')) as Preflight;
  const pair = buildCheckpointPair(preflight);
  const publicPlan = pair.map(({ arm, maxReferenceUsd, promptSha256 }) => ({ arm, maxReferenceUsd, promptSha256 }));
  if (flag !== '--go') {
    console.log(
      JSON.stringify({
        status: 'dry-run',
        calls: 2,
        publicPlan,
        billing: 'API-list-price equivalent only; Codex subscription credits unknown',
      }),
    );
    return;
  }
  const output = join(root, 'checkpoint-run');
  await mkdir(output); // One-shot: a partial or complete run must never be overwritten or replayed.
  const { getProvider } = await import('../../source/providers/registry.js');
  await import('../../source/providers/index.js');
  const settings = {
    get: (key: string) =>
      ((
        { 'agent.model': 'gpt-6-luna', 'agent.transport': 'http', 'agent.retryAttempts': 0 } as Record<string, unknown>
      )[key]),
  } as Parameters<NonNullable<ReturnType<typeof getProvider>['createStreamedModel']>>[1]['settingsService'];
  const logger = { info() {}, warn() {}, error() {}, debug() {}, security() {} } as Parameters<
    NonNullable<ReturnType<typeof getProvider>['createStreamedModel']>
  >[1]['loggingService'];
  const provider = getProvider('codex');
  if (!provider?.createStreamedModel) throw new Error('Codex provider unavailable');
  const results = await runCheckpointPair(pair, {
    createModel: async () =>
      provider.createStreamedModel!('gpt-6-luna', {
        settingsService: settings,
        loggingService: logger,
        retryAttempts: 0,
      }),
    persist: async (result) =>
      writeFile(join(output, `${result.arm}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }),
  });
  console.log(JSON.stringify({ status: 'completed', arms: results.map(({ arm, usage }) => ({ arm, usage })), output }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(formatCheckpointError(error));
    process.exitCode = 1;
  });
}
