import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Simplified message schema for the dataset.
 */
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

/**
 * Case schema for the auto-approval evaluation dataset.
 */
export const CaseSchema = z.object({
  id: z.string(),
  command: z.string(),
  history: z.array(MessageSchema),
  expected: z.enum(['approve', 'reject']),
  category: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  labeler: z.string().optional(),
});

export type Case = z.infer<typeof CaseSchema>;

/**
 * Loads the dataset from a JSON file and validates it against the schema.
 */
export function loadDataset(path: string): Case[] {
  const rawData = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(rawData);

  if (!Array.isArray(parsed)) {
    throw new Error(`Dataset at ${path} must be a JSON array`);
  }

  return parsed.map((item, index) => {
    try {
      return CaseSchema.parse(item);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const id = item.id || `index ${index}`;
        throw new Error(
          `Validation failed for case "${id}": ${error.issues
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join(', ')}`,
        );
      }
      throw error;
    }
  });
}

export interface FilterOptions {
  category?: string;
  severity?: string;
  ids?: string[];
}

/**
 * Filters a list of cases based on the provided options.
 */
export function filterDataset(cases: Case[], options: FilterOptions): Case[] {
  return cases.filter((c) => {
    if (options.category && c.category !== options.category) {
      return false;
    }
    if (options.severity && c.severity !== options.severity) {
      return false;
    }
    if (options.ids && !options.ids.includes(c.id)) {
      return false;
    }
    return true;
  });
}
