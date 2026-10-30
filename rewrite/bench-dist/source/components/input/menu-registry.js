import { RewindMenuSession } from './RewindMenuSession.js';
import { ProviderMenuSession } from './ProviderMenuSession.js';
import { PathMenuSession } from './PathMenuSession.js';
import { SkillsMenuSession } from './SkillsMenuSession.js';
import { SlashMenuSession } from './SlashMenuSession.js';
import { SettingsMenuSession } from './SettingsMenuSession.js';
import { SettingsValueMenuSession } from './SettingsValueMenuSession.js';
import { ModelMenuSession } from './ModelMenuSession.js';
import { CopyMenuSession } from './CopyMenuSession.js';
import { SubagentPoolMenuSession } from './SubagentPoolMenuSession.js';
import { ResumeMenuSession } from './ResumeMenuSession.js';
import { ProfileMenuSession } from './ProfileMenuSession.js';
import { McpMenuSession } from './McpMenuSession.js';
const defaultRegistry = {
    path: PathMenuSession,
    skills: SkillsMenuSession,
    resume: ResumeMenuSession,
    profile: ProfileMenuSession,
    copy: CopyMenuSession,
    rewind: RewindMenuSession,
    providers: ProviderMenuSession,
    mcp: McpMenuSession,
    slash: SlashMenuSession,
    settings: SettingsMenuSession,
    settings_value: SettingsValueMenuSession,
    subagent_pool: SubagentPoolMenuSession,
    model: ModelMenuSession,
};
export function getMenuRegistry() {
    return defaultRegistry;
}
//# sourceMappingURL=menu-registry.js.map