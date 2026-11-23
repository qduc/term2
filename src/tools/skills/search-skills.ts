import { z } from 'zod';
import type { ScriptedToolDefinition } from '../types.js';
import type { SkillsService } from './skills-service.js';
import {
  createBaseMessage,
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
} from '../format-helpers.js';

const searchSkillsSchema = z.object({
  query: z.string().min(1).describe('Keywords, e.g. "lease review" or "tax forms".'),
});

/**
 * Offered only when the skills catalog lists some skills by name only (over its budget):
 * a model rarely greps for a skill it cannot see described, but it does call a tool.
 */
export const createSearchSkillsToolDefinition = (
  skillsService: SkillsService,
): ScriptedToolDefinition<typeof searchSkillsSchema> => ({
  name: 'search_skills',
  description:
    'Search installed skills by keyword, including those the catalog lists by name only. ' +
    "Returns matching skills with descriptions and SKILL.md paths; read a match's SKILL.md to load it.",
  scriptedReturnShape: 'string: one "- name: description" line plus its SKILL.md path per match, or a no-match note',
  scriptedReturnSchema: z.string(),
  parameters: searchSkillsSchema,
  parallelSafe: true,
  needsApproval: () => false,
  execute: async ({ query }) => {
    const matches = skillsService.searchSkills(query);
    if (matches.length === 0) return `No installed skill matches "${query}".`;
    return matches.map((skill) => `- ${skill.name}: ${skill.description}\n  ${skill.location}`).join('\n');
  },
  formatCommandMessage: (item, index, toolCallArgumentsById) => {
    const callId = getCallIdFromItem(item);
    const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
    const args =
      normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
    const output = getOutputText(item);
    return [
      createBaseMessage(item, index, 0, false, {
        command: `search_skills "${args?.query ?? ''}"`,
        output,
        success: isSuccessOutput(output),
        toolName: 'search_skills',
        toolArgs: args,
      }),
    ];
  },
});
