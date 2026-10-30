import { createActivateSkillToolDefinition } from '../../tools/agent/activate-skill.js';
import { createWebFetchToolDefinition } from '../../tools/web/web-fetch.js';
import { createWebSearchToolDefinition } from '../../tools/web/web-search.js';
export function createWebToolDefinitions(deps) {
    return [createWebSearchToolDefinition(deps), createWebFetchToolDefinition(deps)];
}
export function createSelectedActivateSkillTool(skillsService) {
    if (skillsService.getAvailableSkillsForModel().length === 0)
        return undefined;
    return createActivateSkillToolDefinition(skillsService);
}
//# sourceMappingURL=feature-selection.js.map