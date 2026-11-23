import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ILoggingService } from '../../shared/service-interfaces.js';
import { getProjectSkillScopes, getUserSkillScopes } from '../../shared/utils/skill-discovery-paths.js';

export interface SkillInfo {
  name: string;
  description: string;
  location: string; // absolute path to SKILL.md
  /** The scope directory the skill was found under; the catalog lists each once. */
  scopeRoot?: string;
  isProjectLevel: boolean;
  disableModelInvocation?: boolean;
  body: string; // body content of the skill (markdown only, frontmatter stripped)
  rawContent: string; // full contents of SKILL.md including frontmatter
}

/** A longer description is cut, as Claude Code does, so one skill cannot crowd out the rest. */
const MAX_SKILL_DESCRIPTION_CHARS = 1_536;
/** A catalog above this is logged as a warning: about 2% of a 200k-token window, the share Codex budgets. */
const LARGE_CATALOG_CHARS = 16_000;

const ALWAYS_IGNORE = ['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', '.DS_Store'];

export class SkillsService {
  private skills = new Map<string, SkillInfo>();
  private activatedSkills = new Set<string>();

  constructor(private readonly logger: ILoggingService, private readonly projectRoot?: string) {}

  /**
   * Scan for skills in both project-level and user-level scopes.
   */
  discoverSkills(customCwd?: string): void {
    this.skills.clear();
    const cwd = customCwd || this.projectRoot || process.cwd();

    // 1. Resolve discovery directories
    const projectScopes = getProjectSkillScopes(cwd);

    let userScopes: string[] = [];
    try {
      const homeDir = os.homedir();
      if (homeDir) {
        userScopes = getUserSkillScopes(homeDir);
      }
    } catch (e: any) {
      this.logger.debug(`Could not resolve home directory: ${e.message}`);
    }

    // 2. Scan scopes (User scopes first, then project scopes so project overrides user-level)
    for (const scopePath of userScopes) {
      this.scanScope(scopePath, false);
    }
    for (const scopePath of projectScopes) {
      this.scanScope(scopePath, true);
    }
  }

  private scanScope(scopePath: string, isProjectLevel: boolean): void {
    if (!fs.existsSync(scopePath)) return;
    try {
      const stat = fs.statSync(scopePath);
      if (!stat.isDirectory()) return;
      this.scanDirectoryForSkills(scopePath, scopePath, 1, 5, isProjectLevel);
    } catch (e: any) {
      this.logger.error(`Error scanning scope ${scopePath}: ${e.message}`);
    }
  }

  private scanDirectoryForSkills(
    basePath: string,
    currentPath: string,
    depth: number,
    maxDepth: number,
    isProjectLevel: boolean,
  ): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (e: any) {
      this.logger.debug(`Failed to read directory ${currentPath}: ${e.message}`);
      return;
    }

    // Check if the current directory contains a SKILL.md file
    const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
    if (hasSkillMd && currentPath !== basePath) {
      const skillMdPath = path.join(currentPath, 'SKILL.md');
      try {
        const skill = this.loadAndParseSkill(skillMdPath, isProjectLevel);
        if (skill) {
          skill.scopeRoot = basePath;
          const existing = this.skills.get(skill.name);
          if (existing) {
            // Same physical file scanned under both user and project scopes — not a real collision.
            if (existing.location === skill.location) {
              // no-op: already registered
            } else if (existing.isProjectLevel === isProjectLevel) {
              this.logger.debug(
                `Skill name collision: '${skill.name}' is defined at both '${existing.location}' and '${skill.location}'. Using the former.`,
              );
            } else if (isProjectLevel) {
              this.logger.debug(
                `Skill name collision: project-level '${skill.name}' at '${skill.location}' overrides user-level '${existing.location}'.`,
              );
              this.skills.set(skill.name, skill);
            } else {
              this.logger.debug(
                `Skill name collision: user-level '${skill.name}' at '${skill.location}' is shadowed by project-level '${existing.location}'.`,
              );
            }
          } else {
            this.skills.set(skill.name, skill);
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to parse skill at ${skillMdPath}: ${e.message}`);
      }
      return; // Stop recursing once SKILL.md is found in this directory
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORE.includes(entry.name)) continue;
        this.scanDirectoryForSkills(basePath, path.join(currentPath, entry.name), depth + 1, maxDepth, isProjectLevel);
      }
    }
  }

  private loadAndParseSkill(skillMdPath: string, isProjectLevel: boolean): SkillInfo | null {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const normalized = content.replace(/\r\n/g, '\n').trim();

    if (!normalized.startsWith('---')) {
      this.logger.debug(`Skill at ${skillMdPath} is missing YAML frontmatter.`);
      return null;
    }

    const secondDividerIndex = normalized.indexOf('\n---', 3);
    if (secondDividerIndex === -1) {
      this.logger.debug(`Skill at ${skillMdPath} has unclosed YAML frontmatter.`);
      return null;
    }

    const frontmatterStr = normalized.substring(3, secondDividerIndex).trim();
    const body = normalized.substring(secondDividerIndex + 4).trim();

    const metadata = this.parseFrontmatter(frontmatterStr);
    const name = metadata.name?.trim();
    const description = metadata.description?.trim();

    if (!description) {
      this.logger.error(`Skill at ${skillMdPath} is missing a description. Skipping.`);
      return null;
    }

    let finalName = name;
    const parentDirName = path.basename(path.dirname(skillMdPath));
    if (!finalName) {
      this.logger.debug(
        `Skill at ${skillMdPath} is missing a name. Deriving from parent directory: '${parentDirName}'.`,
      );
      finalName = parentDirName;
    }

    if (finalName !== parentDirName) {
      this.logger.debug(
        `Skill name '${finalName}' at ${skillMdPath} does not match parent directory name '${parentDirName}'.`,
      );
    }

    if (finalName.length > 64) {
      this.logger.debug(`Skill name '${finalName}' at ${skillMdPath} exceeds 64 characters.`);
    }

    const disableModelInvocation =
      metadata['disable-model-invocation'] === 'true' || metadata['disable-model-invocation'] === 'true';

    return {
      name: finalName,
      description,
      location: skillMdPath,
      isProjectLevel,
      disableModelInvocation,
      body,
      rawContent: content,
    };
  }

  private parseFrontmatter(frontmatterStr: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = frontmatterStr.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      // Strip surrounding quotes if present
      const cleanValue = value.replace(/^['"]|['"]$/g, '');
      result[key] = cleanValue;
    }
    return result;
  }

  /**
   * Get all discovered skills.
   */
  getAvailableSkills(): SkillInfo[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skills that are allowed to be invoked by the model.
   */
  getAvailableSkillsForModel(): SkillInfo[] {
    return this.getAvailableSkills().filter((s) => !s.disableModelInvocation);
  }

  /**
   * Render the available skills catalog: each scope directory once, then one line per skill.
   * A skill's SKILL.md is `<scope>/<name>/SKILL.md` unless its entry names another path.
   */
  getSkillCatalog(options: { loadVia?: 'tool' | 'shell' | 'read_file' } = {}): string {
    const modelSkills = this.getAvailableSkillsForModel();
    if (modelSkills.length === 0) return '';

    const byScope = new Map<string, SkillInfo[]>();
    for (const skill of modelSkills) {
      const scope = skill.scopeRoot ?? path.dirname(path.dirname(skill.location));
      byScope.set(scope, [...(byScope.get(scope) ?? []), skill]);
    }
    const entry = (scope: string, skill: SkillInfo): string => {
      const relative = path.relative(scope, skill.location);
      const conventional = relative === path.join(skill.name, 'SKILL.md');
      const description =
        skill.description.length > MAX_SKILL_DESCRIPTION_CHARS
          ? `${skill.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…`
          : skill.description;
      return `- ${skill.name}${conventional ? '' : ` (${relative})`}: ${description}`;
    };
    const blocks = [...byScope].map(([scope, skills]) => [scope, ...skills.map((s) => entry(scope, s))].join('\n'));

    const loadInstruction =
      options.loadVia === 'shell'
        ? 'When a task matches a skill, read its SKILL.md with the shell to load its full instructions.'
        : options.loadVia === 'read_file'
        ? 'When a task matches a skill, read its SKILL.md with read_file to load its full instructions.'
        : "When a task matches a skill, call the activate_skill tool with the skill's name to load its full instructions.";

    const catalog = `The following skills provide specialized instructions for specific tasks.
${loadInstruction}
Each skill's SKILL.md is at <folder>/<name>/SKILL.md, under the folder line above it, unless its entry shows another path.

<available_skills>
${blocks.join('\n\n')}
</available_skills>`;
    const summary = `Skills catalog: ${modelSkills.length} skills, ${catalog.length} characters in every request that carries it.`;
    if (catalog.length > LARGE_CATALOG_CHARS) {
      this.logger.warn(`${summary} Consider disable-model-invocation: true on skills that need not be offered.`);
    } else {
      this.logger.debug(summary);
    }
    return catalog;
  }

  /**
   * Activate a skill by name and record it.
   */
  activateSkill(name: string): SkillInfo | undefined {
    const skill = this.skills.get(name);
    if (skill) {
      this.activatedSkills.add(name);
    }
    return skill;
  }

  isActivated(name: string): boolean {
    return this.activatedSkills.has(name);
  }

  clearActivatedSkills(): void {
    this.activatedSkills.clear();
  }
}
