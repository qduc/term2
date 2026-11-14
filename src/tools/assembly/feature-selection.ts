import type { ILoggingService, ISettingsService } from '../../shared/service-interfaces.js';
import { createActivateSkillToolDefinition } from '../agent/activate-skill.js';
import { createWebFetchToolDefinition } from '../web/web-fetch.js';
import { createWebSearchToolDefinition, isWebSearchAvailable } from '../web/web-search.js';
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

/**
 * The web tools an agent can actually use. `web_fetch` needs no configuration; `web_search` is left out
 * (`search` undefined) when no search provider is configured, because every call to it would fail.
 */
export function createWebToolPair(deps: { settingsService: ISettingsService; loggingService: ILoggingService }) {
  return {
    search: isWebSearchAvailable(deps.settingsService) ? createWebSearchToolDefinition(deps) : undefined,
    fetch: createWebFetchToolDefinition(deps),
  };
}

export function createWebToolDefinitions(deps: { settingsService: ISettingsService; loggingService: ILoggingService }) {
  const { search, fetch } = createWebToolPair(deps);
  return search ? ([search, fetch] as const) : ([fetch] as const);
}

export function createSelectedActivateSkillTool(skillsService: SkillsService) {
  if (skillsService.getAvailableSkillsForModel().length === 0) return undefined;
  return createActivateSkillToolDefinition(skillsService);
}
