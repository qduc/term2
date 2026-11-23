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
  /** The scope directory the skill was found under; the catalog lists each once. */
  scopeRoot?: string;
  isProjectLevel: boolean;
  disableModelInvocation?: boolean;
  body: string; // body content of the skill (markdown only, frontmatter stripped)
  rawContent: string; // full contents of SKILL.md including frontmatter
}

/** A longer description is cut, as Claude Code does, so one skill cannot crowd out the rest. */
const MAX_SKILL_DESCRIPTION_CHARS = 1_536;
/**
 * The catalog's share of every request that carries it: Codex's fallback budget, and about
 * Claude Code's 1% of a 200k-token window. Past it, descriptions shorten to their first
 * sentence, then the lowest-priority skills move behind a search instruction.
 */
const SKILL_CATALOG_BUDGET_CHARS = 8_000;
/** A shortened description keeps its first sentence, up to this many characters. */
const SHORT_DESCRIPTION_CHARS = 160;

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
   * Render the available skills catalog: each scope directory once, then one line per skill.
   * A skill's SKILL.md is `<scope>/<name>/SKILL.md` unless its entry names another path.
   *
   * Within `budgetChars` every skill is listed in full. Past it, descriptions shorten to their
   * first sentence; past that, skills are listed in priority order (project before user) and
   * the rest are counted behind a search instruction, because a bare name is not enough for a
   * model to pick a skill.
   */
  /** Skills the last rendered catalog listed by name only; `search_skills` is offered when non-zero. */
  nameOnlyCount = 0;

  getSkillCatalog(
    options: {
      loadVia?: 'tool' | 'shell' | 'read_file';
      /** The reader can run shell commands, so name-only skills can be searched with grep. */
      canSearchWithShell?: boolean;
      /** The reader is offered `search_skills`, which beats grep for finding a name-only skill. */
      searchTool?: boolean;
      budgetChars?: number;
    } = {},
  ): string {
    const modelSkills = this.getAvailableSkillsForModel();
    this.nameOnlyCount = 0;
    if (modelSkills.length === 0) return '';
    const budget = options.budgetChars ?? SKILL_CATALOG_BUDGET_CHARS;
    const canSearch = options.canSearchWithShell ?? options.loadVia === 'shell';

    const scopeOf = (skill: SkillInfo) => skill.scopeRoot ?? path.dirname(path.dirname(skill.location));
    // Project skills describe this repository's work, so they keep their place first.
    const ordered = [...modelSkills.filter((s) => s.isProjectLevel), ...modelSkills.filter((s) => !s.isProjectLevel)];
    const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
    const shorten = (text: string) => cut(/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text, SHORT_DESCRIPTION_CHARS);
    const label = (skill: SkillInfo): string => {
      const relative = path.relative(scopeOf(skill), skill.location);
      return relative === path.join(skill.name, 'SKILL.md') ? skill.name : `${skill.name} (${relative})`;
    };
    const entry = (skill: SkillInfo, short: boolean): string =>
      `- ${label(skill)}: ${short ? shorten(skill.description) : cut(skill.description, MAX_SKILL_DESCRIPTION_CHARS)}`;

    const loadInstruction =
      options.loadVia === 'shell'
        ? 'When a task matches a skill, read its SKILL.md with the shell to load its full instructions.'
        : options.loadVia === 'read_file'
        ? 'When a task matches a skill, read its SKILL.md with read_file to load its full instructions.'
        : "When a task matches a skill, call the activate_skill tool with the skill's name to load its full instructions.";
    const scopes = [...new Set(ordered.map(scopeOf))];
    const nameOnlyBlock = (skills: SkillInfo[]): string => {
      if (skills.length === 0) return '';
      const byScope = new Map<string, string[]>();
      for (const skill of skills) byScope.set(scopeOf(skill), [...(byScope.get(scopeOf(skill)) ?? []), label(skill)]);
      const how = options.searchTool
        ? 'Call search_skills with a keyword to see their descriptions before deciding no skill fits a task.'
        : canSearch
        ? `Search their descriptions by keyword before deciding no skill fits a task: grep -ril --include=SKILL.md "<keyword>" ${scopes
            .map((s) => JSON.stringify(s))
            .join(' ')}`
        : '';
      const lists = [...byScope].map(([scope, names]) => `${scope}: ${names.join(', ')}`).join('\n');
      return `\n\nAlso installed, listed by name only (over the catalog budget). ${how}\n${lists}`;
    };
    const render = (described: { skill: SkillInfo; short: boolean }[], nameOnly: SkillInfo[]): string => {
      const byScope = new Map<string, string[]>();
      for (const { skill, short } of described)
        byScope.set(scopeOf(skill), [...(byScope.get(scopeOf(skill)) ?? []), entry(skill, short)]);
      const blocks = [...byScope].map(([scope, lines]) => [scope, ...lines].join('\n'));
      return `The following skills provide specialized instructions for specific tasks.
${loadInstruction}
Each skill's SKILL.md is at <folder>/<name>/SKILL.md, under the folder line above it, unless its entry shows another path.

<available_skills>
${blocks.join('\n\n')}${nameOnlyBlock(nameOnly)}
</available_skills>`;
    };

    let catalog = render(
      ordered.map((skill) => ({ skill, short: false })),
      [],
    );
    if (catalog.length > budget)
      catalog = render(
        ordered.map((skill) => ({ skill, short: true })),
        [],
      );
    if (catalog.length > budget) {
      // Describe the longest prefix of the priority order that fits; every other skill keeps its name.
      // When even the names exceed the budget they are all still listed: no skill is ever hidden.
      let fit = 0;
      while (fit < ordered.length) {
        const next = render(
          ordered.slice(0, fit + 1).map((skill) => ({ skill, short: true })),
          ordered.slice(fit + 1),
        );
        if (next.length > budget) break;
        fit++;
      }
      this.nameOnlyCount = ordered.length - fit;
      catalog = render(
        ordered.slice(0, fit).map((skill) => ({ skill, short: true })),
        ordered.slice(fit),
      );
    }

    const summary = `Skills catalog: ${modelSkills.length} skills, ${catalog.length} characters in every request that carries it.`;
    if (this.nameOnlyCount > 0) {
      this.logger.warn(
        `${summary} ${this.nameOnlyCount} skills are over the ${budget}-character budget and listed by name only.`,
      );
    } else {
      this.logger.debug(summary);
    }
    return catalog;
  }

  /** Rank skills against a keyword query by name, description and body. */
  searchSkills(query: string, limit = 8): SkillInfo[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const score = (skill: SkillInfo) =>
      terms.reduce((sum, term) => {
        const hit = (text: string) => (text.toLowerCase().includes(term) ? 1 : 0);
        return sum + 3 * hit(skill.name) + 2 * hit(skill.description) + hit(skill.body);
      }, 0);
    return this.getAvailableSkillsForModel()
      .map((skill) => ({ skill, score: score(skill) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.skill);
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
