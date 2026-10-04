import { z } from 'zod';

export const ModelSelectionSchema = z.object({
  model: z.string().trim().min(1),
  provider: z.string().trim().min(1),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
