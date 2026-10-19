import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { createActivateSkillToolDefinition } from '../../tools/agent/activate-skill.js';
import { createWebFetchToolDefinition } from '../../tools/web/web-fetch.js';
import { createWebSearchToolDefinition } from '../../tools/web/web-search.js';
import type { SkillsService } from '../skills/skills-service.js';

/**
 * Caller-owned feature choice for the two shared factories.
 *
 * The booleans record a decision the caller already made (profile capability,
 * kill switch, role flag, or catalog). They do not grant a permission the
 * caller withheld, and they do not apply child scope wrappers.
 */
export interface FeatureSelection {
  web: boolean;
  activateSkill: boolean;
}

export function createWebToolDefinitions(deps: { settingsService: ISettingsService; loggingService: ILoggingService }) {
  return [createWebSearchToolDefinition(deps), createWebFetchToolDefinition(deps)] as const;
}

export function createSelectedActivateSkillTool(skillsService: SkillsService) {
  if (skillsService.getAvailableSkillsForModel().length === 0) return undefined;
  return createActivateSkillToolDefinition(skillsService);
}
