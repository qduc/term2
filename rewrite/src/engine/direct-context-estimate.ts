/** The request-size estimate compaction and input admission use: rendered bytes / 4, as legacy's estimateContext. */
import type { ModelRequest } from '../model/index.js';

export type DirectContextEstimate = {
  readonly renderedInputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly hardFitTokens: number;
};

/** Conservative bytes/4 estimate with the existing 10% capacity reserve. Never changes history. */
export function estimateDirectContext(request: ModelRequest, contextWindow?: number): DirectContextEstimate {
  const renderedInputTokens = Math.ceil(
    bytes({ instructions: request.instructions, tools: request.tools.map(legacyToolShape), history: request.input }) /
      4,
  );
  const outputReserveTokens = Math.max(0, Math.ceil(request.maxOutputTokens ?? 0));
  const safetyReserveTokens = Math.ceil((contextWindow ?? 0) * 0.1);
  return {
    renderedInputTokens,
    outputReserveTokens,
    safetyReserveTokens,
    hardFitTokens: renderedInputTokens + outputReserveTokens + safetyReserveTokens,
  };
}

/** Tools as legacy's estimate serializes them (toModelTools), so budgets and triggers land where legacy's do. */
function legacyToolShape(tool: ModelRequest['tools'][number]): unknown {
  return tool.modelTool
    ? { type: tool.modelTool.type, name: tool.name, description: tool.description, format: tool.modelTool.format }
    : { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}
