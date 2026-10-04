import { z } from 'zod';

export const ModelSelectionSchema = z.object({
  model: z.string().trim().min(1),
  provider: z.string().trim().min(1),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const LEGACY_BOUND_MODEL_KEYS = [
  'efficientModel',
  'capableModel',
  'mentorModel',
  'subagentExplorerModel',
  'subagentWorkerModel',
  'subagentLibrarianModel',
  'autoApproveModel',
] as const;

/** Apply one input layer. Explicit pairs replace rather than deep-merge. */
export function mainSelectionForLayer(layer: Record<string, unknown>, previous?: ModelSelection): unknown {
  if (Object.hasOwn(layer, 'modelSelection')) return layer.modelSelection;
  return {
    model: layer.model === undefined ? previous?.model ?? 'gpt-5.1' : layer.model,
    provider: layer.provider === undefined ? previous?.provider ?? 'openai' : layer.provider,
  };
}

export function isMainSelectionKey(key: string): boolean {
  return key === 'agent.model' || key === 'agent.provider' || key === 'agent.modelSelection';
}
