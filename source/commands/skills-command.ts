import type { SlashCommand } from '../slash-commands.js';
import type { SkillsService, SkillInfo } from '../services/skills/skills-service.js';
import { SKILLS_TRIGGER } from '../components/input/triggers.js';

export const createSkillsSlashCommand = (deps: {
  skillsService: SkillsService;
  onSkillSelected: (skill: SkillInfo) => void;
  addSystemMessage: (text: string) => void;
  replaceInput: (text: string) => void;
}): SlashCommand => ({
  name: 'skills',
  description: 'Activate a skill for the next request',
  expectsArgs: true,
  completion: { type: 'skills', trigger: SKILLS_TRIGGER },
  action: (args?: string) => {
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
