import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProjectSkillScopes, getUserSkillScopes } from '../../utils/skill-discovery-paths.js';
const ALWAYS_IGNORE = ['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', '.DS_Store'];
export class SkillsService {
    logger;
    projectRoot;
    skills = new Map();
    activatedSkills = new Set();
    constructor(logger, projectRoot) {
        this.logger = logger;
        this.projectRoot = projectRoot;
    }
    /**
     * Scan for skills in both project-level and user-level scopes.
     */
    discoverSkills(customCwd) {
        this.skills.clear();
        const cwd = customCwd || this.projectRoot || process.cwd();
        // 1. Resolve discovery directories
        const projectScopes = getProjectSkillScopes(cwd);
        let userScopes = [];
        try {
            const homeDir = os.homedir();
            if (homeDir) {
                userScopes = getUserSkillScopes(homeDir);
            }
        }
        catch (e) {
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
    scanScope(scopePath, isProjectLevel) {
        if (!fs.existsSync(scopePath))
            return;
        try {
            const stat = fs.statSync(scopePath);
            if (!stat.isDirectory())
                return;
            this.scanDirectoryForSkills(scopePath, scopePath, 1, 5, isProjectLevel);
        }
        catch (e) {
            this.logger.error(`Error scanning scope ${scopePath}: ${e.message}`);
        }
    }
    scanDirectoryForSkills(basePath, currentPath, depth, maxDepth, isProjectLevel) {
        if (depth > maxDepth)
            return;
        let entries;
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        }
        catch (e) {
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
                        }
                        else if (existing.isProjectLevel === isProjectLevel) {
                            this.logger.debug(`Skill name collision: '${skill.name}' is defined at both '${existing.location}' and '${skill.location}'. Using the former.`);
                        }
                        else if (isProjectLevel) {
                            this.logger.debug(`Skill name collision: project-level '${skill.name}' at '${skill.location}' overrides user-level '${existing.location}'.`);
                            this.skills.set(skill.name, skill);
                        }
                        else {
                            this.logger.debug(`Skill name collision: user-level '${skill.name}' at '${skill.location}' is shadowed by project-level '${existing.location}'.`);
                        }
                    }
                    else {
                        this.skills.set(skill.name, skill);
                    }
                }
            }
            catch (e) {
                this.logger.error(`Failed to parse skill at ${skillMdPath}: ${e.message}`);
            }
            return; // Stop recursing once SKILL.md is found in this directory
        }
        // Recurse into subdirectories
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (ALWAYS_IGNORE.includes(entry.name))
                    continue;
                this.scanDirectoryForSkills(basePath, path.join(currentPath, entry.name), depth + 1, maxDepth, isProjectLevel);
            }
        }
    }
    loadAndParseSkill(skillMdPath, isProjectLevel) {
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
            this.logger.debug(`Skill at ${skillMdPath} is missing a name. Deriving from parent directory: '${parentDirName}'.`);
            finalName = parentDirName;
        }
        if (finalName !== parentDirName) {
            this.logger.debug(`Skill name '${finalName}' at ${skillMdPath} does not match parent directory name '${parentDirName}'.`);
        }
        if (finalName.length > 64) {
            this.logger.debug(`Skill name '${finalName}' at ${skillMdPath} exceeds 64 characters.`);
        }
        const disableModelInvocation = metadata['disable-model-invocation'] === 'true' || metadata['disable-model-invocation'] === 'true';
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
    parseFrontmatter(frontmatterStr) {
        const result = {};
        const lines = frontmatterStr.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const colonIndex = trimmed.indexOf(':');
            if (colonIndex === -1)
                continue;
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
    getAvailableSkills() {
        return Array.from(this.skills.values());
    }
    /**
     * Get skills that are allowed to be invoked by the model.
     */
    getAvailableSkillsForModel() {
        return this.getAvailableSkills().filter((s) => !s.disableModelInvocation);
    }
    /**
     * Render the available skills catalog XML block.
     */
    getSkillCatalog(options = {}) {
        const modelSkills = this.getAvailableSkillsForModel();
        if (modelSkills.length === 0)
            return '';
        const skillBlocks = modelSkills
            .map((s) => `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <location>${s.location}</location>
  </skill>`)
            .join('\n');
        const loadInstruction = options.loadVia === 'shell'
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
    activateSkill(name) {
        const skill = this.skills.get(name);
        if (skill) {
            this.activatedSkills.add(name);
        }
        return skill;
    }
    isActivated(name) {
        return this.activatedSkills.has(name);
    }
    clearActivatedSkills() {
        this.activatedSkills.clear();
    }
}
//# sourceMappingURL=skills-service.js.map