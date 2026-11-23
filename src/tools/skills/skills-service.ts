import fs from 'fs';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import type { ILoggingService } from '../../shared/service-interfaces.js';
import { getProjectSkillScopes, getUserSkillScopes } from '../../shared/utils/skill-discovery-paths.js';

export interface SkillInfo {
  name: string;
  description: string;
  location: string; // absolute path to SKILL.md
  isProjectLevel: boolean;
  disableModelInvocation?: boolean;
  body: string; // body content of the skill (markdown only, frontmatter stripped)
  rawContent: string; // full contents of SKILL.md including frontmatter
}

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
    const normalized = content
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .trimStart();

    if (!/^---[ \t]*(?:\n|$)/.test(normalized)) {
      this.logger.debug(`Skill at ${skillMdPath} is missing YAML frontmatter.`);
      return null;
    }

    const frontmatterMatch = normalized.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
    if (!frontmatterMatch) {
      this.logger.debug(`Skill at ${skillMdPath} has unclosed YAML frontmatter.`);
      return null;
    }

    const frontmatterStr = frontmatterMatch[1] ?? '';
    const body = normalized.slice(frontmatterMatch[0].length).trim();

    const metadata = this.parseFrontmatter(frontmatterStr, skillMdPath);
    const name = this.readScalarString(metadata.name);
    const description = this.readScalarString(metadata.description);

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

    const disableModelInvocation = this.readScalarString(metadata['disable-model-invocation']) === 'true';

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

  private readScalarString(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    return undefined;
  }

  private parseFrontmatter(frontmatterStr: string, skillMdPath: string): Record<string, unknown> {
    if (!frontmatterStr.trim()) {
      return {};
    }

    try {
      const parsed: unknown = YAML.parse(frontmatterStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.debug(
        `Failed to parse YAML frontmatter at ${skillMdPath} (${message}); falling back to line parser.`,
      );
      return this.parseFrontmatterFallback(frontmatterStr);
    }
  }

  private parseFrontmatterFallback(frontmatterStr: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = frontmatterStr.split('\n');
    let currentKey: string | null = null;
    let currentLines: string[] = [];

    const flush = () => {
      if (currentKey === null) return;
      const joined = currentLines.join('\n').trim();
      result[currentKey] = joined.replace(/^['"]|['"]$/g, '');
      currentKey = null;
      currentLines = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentKey !== null) currentLines.push('');
        continue;
      }
      if (currentKey === null && trimmed.startsWith('#')) continue;

      // Indented lines continue the previous key's value
      if (/^[ \t]+/.test(line) && currentKey !== null) {
        currentLines.push(trimmed);
        continue;
      }

      if (trimmed.startsWith('#')) {
        flush();
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      flush();
      currentKey = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (value && !/^[>|][+-]?$/.test(value)) {
        currentLines.push(value);
      }
    }
    flush();
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
   * Render the available skills catalog XML block.
   */
  getSkillCatalog(options: { loadVia?: 'tool' | 'shell' } = {}): string {
    const modelSkills = this.getAvailableSkillsForModel();
    if (modelSkills.length === 0) return '';

    const skillBlocks = modelSkills
      .map(
        (s) => `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <location>${s.location}</location>
  </skill>`,
      )
      .join('\n');

    const loadInstruction =
      options.loadVia === 'shell'
        ? `When a task matches a skill's description, read the SKILL.md at its
location with the shell to load its full instructions.`
        : `When a task matches a skill's description, call the activate_skill tool
with the skill's name to load its full instructions.`;

    return `The following skills provide specialized instructions for specific tasks.
${loadInstruction}

<available_skills>
${skillBlocks}
</available_skills>`;
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
