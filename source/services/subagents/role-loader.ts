import path from 'node:path';
import fs from 'node:fs';
import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentRole, SubagentDefinition } from './types.js';
import type { AnyToolDefinition } from '../../tools/types.js';
import { isGpt5OrGpt6Model } from '../../lib/tool-selection-policy.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import type { ExecutionContext } from '../execution-context.js';
import { getShellSandboxAddendum } from '../../prompts/shell-sandbox.js';
import { getSearchViaShellAddendum } from '../../prompts/search-via-shell.js';
import type { SkillsService } from '../skills/skills-service.js';
import { MemoryCapabilityBuilder } from '../memory/memory-capabilities.js';
import { getTierModelPoolEntries, resolveAncillaryModelTier } from '../agent-runtime/model-resolver.js';
import { getAncillaryTierForRole } from './subagent-pool-config.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, '../../prompts');
export const PROMPTS_DIR = path.join(BASE_PROMPT_PATH, 'subagents');

/**
 * Fallback when a role markdown file omits `maxTurns`.
 * Generous tripwire, not a workload estimate — healthy runs should rarely
 * approach it; settlement reports a budget stop rather than failing.
 */
export const ROLE_MAX_TURNS_DEFAULT = 200;

const isInherited = (value: unknown): boolean =>
  value === 'inherit' || value === undefined || value === null || value === '';

export function resolvePrompt(promptPath: string): string {
  try {
    return fs.readFileSync(promptPath, 'utf-8').trim();
  } catch (e: any) {
    const relativePromptPath = path.relative(BASE_PROMPT_PATH, promptPath);
    const sourcePromptPath = path.join(
      import.meta.dirname,
      '../../../source/prompts',
      relativePromptPath.startsWith('..') ? path.basename(promptPath) : relativePromptPath,
    );
    if (sourcePromptPath !== promptPath && fs.existsSync(sourcePromptPath)) {
      return fs.readFileSync(sourcePromptPath, 'utf-8').trim();
    }
    throw new Error(`Failed to read prompt file at ${promptPath}: ${e.message}`);
  }
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of frontmatterText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();

    const quoted =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    if (quoted) {
      frontmatter[key] = raw.slice(1, -1);
      continue;
    }

    if (raw === 'true') {
      frontmatter[key] = true;
    } else if (raw === 'false') {
      frontmatter[key] = false;
    } else if (!isNaN(Number(raw)) && raw !== '') {
      frontmatter[key] = Number(raw);
    } else {
      frontmatter[key] = raw;
    }
  }

  return { frontmatter, body: body.trim() };
}

export function loadRoleDefinition(role: SubagentRole, settings: ISettingsService): SubagentDefinition {
  if (role === 'librarian' && settings.get('memory.enabled') === false) {
    throw new Error('The librarian subagent is unavailable because persistent memory is disabled.');
  }

  const filePath = path.join(PROMPTS_DIR, `${role}.md`);

  let content: string;
  try {
    content = resolvePrompt(filePath);
  } catch (error: any) {
    throw new Error(`Unknown subagent role: "${role}". No definition found at ${filePath}. Error: ${error.message}`);
  }

  const { frontmatter, body } = parseFrontmatter(content);

  const subagentPrefix =
    role === 'mentor' ? 'agent.mentor' : `agent.subagent${role.charAt(0).toUpperCase() + role.slice(1)}`;

  const tier = getAncillaryTierForRole(role);
  const tierModel = resolveAncillaryModelTier(tier, settings);
  const legacyModel = settings.getDynamic(`${subagentPrefix}Model`) as string | undefined;
  const legacyProvider = settings.getDynamic(`${subagentPrefix}Provider`) as string | undefined;
  const configuredLegacyReasoningEffort = settings.getDynamic(`${subagentPrefix}ReasoningEffort`) as string | undefined;
  const legacyReasoningEffort =
    role === 'mentor' && configuredLegacyReasoningEffort === 'default' ? undefined : configuredLegacyReasoningEffort;
  const firstPoolEntry = getTierModelPoolEntries(tier, settings)[0];
  const model = isInherited(frontmatter.model)
    ? firstPoolEntry?.model ?? legacyModel ?? tierModel.model
    : frontmatter.model;
  // A pool entry picked from another provider pins it; keep model and
  // provider paired so the definition never runs a model on the wrong host.
  const provider = isInherited(frontmatter.provider)
    ? firstPoolEntry?.provider ??
      (settings.getDynamic(`agent.${tier}Provider`) as string | undefined) ??
      legacyProvider ??
      tierModel.provider
    : frontmatter.provider;

  return {
    role,
    name: frontmatter.name ?? role,
    instructions: body,
    canRead: frontmatter.canRead ?? false,
    canWrite: frontmatter.canWrite ?? false,
    canSearchWeb: frontmatter.canSearchWeb ?? false,
    canRunShell: frontmatter.canRunShell ?? false,
    maxTurns: frontmatter.maxTurns ?? ROLE_MAX_TURNS_DEFAULT,
    model,
    provider,
    reasoningEffort: isInherited(frontmatter.reasoningEffort)
      ? (settings.getDynamic(`agent.${tier}ReasoningEffort`) as string | undefined) ??
        legacyReasoningEffort ??
        settings.get('agent.reasoningEffort') ??
        'default'
      : frontmatter.reasoningEffort,
    description: frontmatter.description ?? '',
  };
}

export function selectSubagentBasePromptFile(model: string): string {
  const normalizedModel = model.toLowerCase();
  if (isGpt5OrGpt6Model(normalizedModel) && normalizedModel.includes('codex')) {
    return 'base-codex.md';
  }
  if (normalizedModel.includes('sonnet') || normalizedModel.includes('haiku')) {
    return 'base-anthropic.md';
  }
  if (isGpt5OrGpt6Model(normalizedModel)) {
    return 'base-gpt-5-modern.md';
  }
  return 'base-simple.md';
}

export function resolveSubagentSearchViaShell(settings: ISettingsService, canRunShell: boolean): boolean {
  // Uniform across models: only an explicit `on` routes subagent search
  // through the shell; `auto` behaves like `off`.
  return settings.get('app.searchViaShell') === 'on' && canRunShell;
}

export function buildAvailableToolGuidance(
  toolDefinitions: readonly Pick<AnyToolDefinition, 'name'>[],
  searchViaShell: boolean,
): string {
  const toolNames = toolDefinitions.map((tool) => tool.name);
  const hasTool = (name: string) => toolNames.includes(name);
  const lines = [
    '## Available Tool Guidance',
    '',
    `Registered tools: ${toolNames.length > 0 ? toolNames.map((name) => `\`${name}\``).join(', ') : 'none'}.`,
    '',
    'Use only these tools. If a tool mentioned elsewhere is not listed here, it is not available.',
  ];

  if (searchViaShell && hasTool('shell')) {
    lines.push('For workspace search, use `shell` with commands like `rg` for text search and `fd` for file search.');
    const fallbackSearchTools = ['grep', 'glob'].filter(hasTool).map((name) => `\`${name}\``);
    if (fallbackSearchTools.length > 0) {
      lines.push(`If shell search is blocked, use the dedicated search tools: ${fallbackSearchTools.join(', ')}.`);
    }
  } else if (hasTool('grep') || hasTool('glob')) {
    const searchTools = ['grep', 'glob'].filter(hasTool).map((name) => `\`${name}\``);
    lines.push(`For workspace search, use the dedicated search tools: ${searchTools.join(', ')}.`);
  } else {
    lines.push('No dedicated workspace search tool is available. Use `read_file` and provided context where possible.');
  }

  if (hasTool('read_code_outline') || hasTool('code_context_search')) {
    const codeContextTools = ['read_code_outline', 'code_context_search'].filter(hasTool).map((name) => `\`${name}\``);
    lines.push(`For code structure and symbol context, use: ${codeContextTools.join(', ')}.`);
  } else {
    lines.push('Code-context tools are not available in this run.');
  }

  if (hasTool('read_file')) {
    lines.push('Use `read_file` for exact file contents before drawing conclusions or editing.');
  }
  if (hasTool('shell')) {
    lines.push('Use `shell` only for commands that are safe, bounded, and relevant to the assigned task.');
  }
  if (hasTool('apply_patch') || hasTool('search_replace') || hasTool('create_file')) {
    const writeTools = ['apply_patch', 'search_replace', 'create_file'].filter(hasTool).map((name) => `\`${name}\``);
    lines.push(`For edits, use the registered write tools: ${writeTools.join(', ')}.`);
  }
  if (hasTool('web_search') || hasTool('web_fetch')) {
    lines.push('Use web tools only when current external information or documentation is needed.');
  }

  return lines.join('\n');
}

export function buildInstructions(
  definition: SubagentDefinition,
  toolDefinitions: readonly Pick<AnyToolDefinition, 'name'>[],
  searchViaShell: boolean,
  settings: ISettingsService,
  executionContext?: ExecutionContext,
  skillsService?: SkillsService,
): string {
  const envInfo = getEnvInfo(settings, executionContext);
  const cwd = executionContext?.getCwd() ?? process.cwd();
  const agentsInstructions = executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

  const modelPrompt = resolvePrompt(path.join(PROMPTS_DIR, selectSubagentBasePromptFile(definition.model)));
  const worktreeHygiene = resolvePrompt(path.join(PROMPTS_DIR, 'worktree-hygiene.md'));
  const toolGuidance = buildAvailableToolGuidance(toolDefinitions, searchViaShell);
  const memoryCapability = new MemoryCapabilityBuilder(settings).build(
    { kind: 'subagent', role: definition.role },
    { projectPath: cwd },
  );

  const sandboxEnabled = settings.get('sandbox.enabled') ?? true;
  const inlineSections: string[] = [];

  if (sandboxEnabled) {
    inlineSections.push(getShellSandboxAddendum());
  }

  if (searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  }

  let skillsInstructions = '';
  if (skillsService) {
    const catalog = skillsService.getSkillCatalog();
    if (catalog) {
      skillsInstructions = `\n\n${catalog}`;
    }
  }

  return [
    modelPrompt,
    resolvePrompt(path.join(BASE_PROMPT_PATH, 'fragments/skill-instruction-conflicts.md')),
    worktreeHygiene,
    definition.instructions,
    memoryCapability.guidance,
    memoryCapability.context,
    toolGuidance,
    ...inlineSections,
    `Environment: ${envInfo}${agentsInstructions}${skillsInstructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
