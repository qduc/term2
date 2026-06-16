import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { ToolDefinition } from '../types.js';
import type { SkillsService } from '../../services/skills/skills-service.js';
import { getCallIdFromItem, getOutputText, normalizeToolArguments, createBaseMessage } from '../format-helpers.js';

const ACTIVATE_SKILL_DESCRIPTION = 'Load the full instructions for a specified skill to perform a specialized task.';

const ALWAYS_IGNORE = ['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', '.DS_Store'];

export const createActivateSkillToolDefinition = (skillsService: SkillsService): ToolDefinition => {
  const availableSkills = skillsService.getAvailableSkillsForModel();
  const skillNames = availableSkills.map((s) => s.name);

  const nameSchema =
    skillNames.length > 0
      ? z.enum(skillNames as [string, ...string[]]).describe('The name of the skill to activate.')
      : z.string().describe('The name of the skill to activate.');

  const activateSkillSchema = z.object({
    name: nameSchema,
  });

  return {
    name: 'activate_skill',
    description: ACTIVATE_SKILL_DESCRIPTION,
    parameters: activateSkillSchema,
    needsApproval: () => false, // Safe operation
    execute: async (params) => {
      const { name } = params;
      const skill = skillsService.activateSkill(name);
      if (!skill) {
        return `Error: Skill '${name}' not found.`;
      }

      const baseDir = path.dirname(skill.location);
      let resourceXml = '';

      try {
        if (fs.existsSync(baseDir)) {
          const scanFiles = (dir: string): string[] => {
            const results: string[] = [];
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const file of list) {
              const filePath = path.join(dir, file.name);
              if (file.isDirectory()) {
                if (!ALWAYS_IGNORE.includes(file.name)) {
                  results.push(...scanFiles(filePath));
                }
              } else {
                results.push(path.relative(baseDir, filePath));
              }
            }
            return results;
          };

          const resources = scanFiles(baseDir).filter((r) => r !== 'SKILL.md');
          if (resources.length > 0) {
            resourceXml = `\n\n<skill_resources>\n${resources
              .map((r) => `  <file>${r}</file>`)
              .join('\n')}\n</skill_resources>`;
          }
        }
      } catch (e: any) {
        // Ignore or log error
      }

      return `<skill_content name="${skill.name}">
${skill.body}

Skill directory: ${baseDir}
Relative paths in this skill are relative to the skill directory.${resourceXml}
</skill_content>`;
    },
    formatCommandMessage: (item, index, toolCallArgumentsById) => {
      const callId = getCallIdFromItem(item);
      const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
      const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
      const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};
      const skillName = args?.name ?? 'unknown';

      return [
        createBaseMessage(item, index, 0, false, {
          command: `activate_skill "${skillName}"`,
          output: getOutputText(item) || 'Activated successfully.',
          success: !getOutputText(item)?.startsWith('Error:'),
          toolName: 'activate_skill',
          toolArgs: args,
        }),
      ];
    },
  };
};
