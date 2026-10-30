import { SKILLS_TRIGGER } from '../components/input/triggers.js';
export const createSkillsSlashCommand = (deps) => ({
    name: 'skills',
    description: 'Activate a skill for the next request',
    expectsArgs: true,
    completion: { type: 'skills', trigger: SKILLS_TRIGGER },
    action: (args) => {
        const skillName = args?.trim().split(/\s+/)[0];
        if (!skillName) {
            deps.replaceInput('/skills ');
            return false;
        }
        const skill = deps.skillsService.getAvailableSkills().find((s) => s.name.toLowerCase() === skillName.toLowerCase());
        if (!skill) {
            deps.addSystemMessage(`Unknown skill: "${skillName}". Use /skills with Tab to browse available skills.`);
            return true;
        }
        deps.onSkillSelected(skill);
        deps.addSystemMessage(`Skill "${skill.name}" activated. Type your request (or press Esc to cancel).`);
        return true;
    },
});
//# sourceMappingURL=skills-command.js.map