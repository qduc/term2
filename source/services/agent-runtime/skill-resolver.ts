import type { SkillsService } from '../skills/skills-service.js';

export interface SkillResolutionResult {
  /** Concatenated instruction bodies from resolved skills. */
  instructions: string;
  /** Errors for skills that could not be resolved. */
  errors: SkillResolutionError[];
}

export interface SkillResolutionError {
  code: 'unknown_skill' | 'unsupported_contribution';
  skillName: string;
  message: string;
}

/**
 * Resolve a list of skill names into their instruction bodies and
 * collect errors for unknown or unsupported skills.
 *
 * **Capability guard**: Skills only contribute instruction bodies (`body`).
 * The current SkillInfo type has no fields for tool definitions, resource
 * grants, output contracts, or permission elevation, so skills cannot
 * grant or widen authority. If SkillInfo is extended in the future, any
 * new authority-bearing field must be explicitly validated here and
 * rejected with `unsupported_contribution` unless the runtime supports it.
 *
 * The MVP only supports instruction contributions. Any skill requesting
 * tool definitions, resource grants, output contracts, or permission
 * elevation is rejected with `unsupported_contribution`.
 */
export function resolveSkills(
  skillNames: ReadonlyArray<string> | undefined,
  skillsService: SkillsService,
): SkillResolutionResult {
  if (!skillNames || skillNames.length === 0) {
    return { instructions: '', errors: [] };
  }

  const instructions: string[] = [];
  const errors: SkillResolutionError[] = [];

  for (const name of skillNames) {
    const skill = skillsService.getAvailableSkills().find((s) => s.name === name);
    if (!skill) {
      errors.push({
        code: 'unknown_skill',
        skillName: name,
        message: `Unknown skill: "${name}". Available skills can be discovered via the skills command.`,
      });
      continue;
    }

    // MVP: only instruction contributions are supported.
    instructions.push(skill.body);
  }

  return {
    instructions: instructions.join('\n\n'),
    errors,
  };
}
