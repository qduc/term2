import path from 'node:path';
import fs from 'node:fs';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import type { SubagentRole, SubagentDefinition } from './types.js';
import type { AnyToolDefinition } from '../../tools/types.js';
import { isGpt5OrGpt6Model } from '../../model/tool-selection-policy.js';
import { getEnvInfo, getAgentsInstructions } from '../../session/prompts/environment.js';
import type { ExecutionContext } from '../../tools/execution-context.js';
import { getShellSandboxAddendum } from '../../session/prompts/shell-sandbox.js';
import { getSearchViaShellAddendum } from '../../session/prompts/search-via-shell.js';
import type { SkillsService } from '../../tools/skills/skills-service.js';
import { MemoryCapabilityBuilder } from '../../tools/memory/memory-capabilities.js';
import { resolveAncillaryModelTier } from '../../session/agent-runtime/model-resolver.js';
import { getAncillaryTierForRole } from './subagent-pool-config.js';
import { ModelSelectionSchema } from '../../config/settings/model-selection.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, '../../session/prompts');
const PROMPTS_DIR = path.join(BASE_PROMPT_PATH, 'subagents');

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
      '../../session/prompts',
      relativePromptPath.startsWith('..') ? path.basename(promptPath) : relativePromptPath,
    );
    if (sourcePromptPath !== promptPath && fs.existsSync(sourcePromptPath)) {
      return fs.readFileSync(sourcePromptPath, 'utf-8').trim();
    }
    throw new Error(`Failed to read prompt file at ${promptPath}: ${e.message}`);
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
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
  const configuredLegacyReasoningEffort = settings.getDynamic(`${subagentPrefix}ReasoningEffort`) as string | undefined;
  const legacyReasoningEffort =
    role === 'mentor' && configuredLegacyReasoningEffort === 'default' ? undefined : configuredLegacyReasoningEffort;
  const inheritsModel = isInherited(frontmatter.model);
  const inheritsProvider = isInherited(frontmatter.provider);
  if (inheritsModel !== inheritsProvider) {
    throw new Error(`Role "${role}" must override model and provider together.`);
  }
  const selection = ModelSelectionSchema.parse(
    inheritsModel ? tierModel : { model: frontmatter.model, provider: frontmatter.provider },
  );

  return {
    role,
    name: frontmatter.name ?? role,
    instructions: body,
    instructionsSource: 'role-file',
    canRead: frontmatter.canRead ?? false,
    canWrite: frontmatter.canWrite ?? false,
    canSearchWeb: frontmatter.canSearchWeb ?? false,
    canRunShell: frontmatter.canRunShell ?? false,
    maxTurns: frontmatter.maxTurns ?? ROLE_MAX_TURNS_DEFAULT,
    ...selection,
    reasoningEffort: isInherited(frontmatter.reasoningEffort)
      ? (settings.getDynamic(`agent.${tier}ReasoningEffort`) as string | undefined) ??
        legacyReasoningEffort ??
        settings.get('agent.reasoningEffort') ??
        'default'
      : frontmatter.reasoningEffort,
    description: frontmatter.description ?? '',
  };
}

function selectSubagentBasePromptFile(model: string): string {
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

/**
 * Tools that cannot change workspace files. A child offered only these
 * provably cannot write files. Any other tool counts as possibly writing unless
 * its policy wrapper marks it `cannotWriteFiles`: `shell` (a writable generic
 * child's shell can edit; a read-only child's shell is marked), `run_code`,
 * `run_subagent`, and tools added later.
 */
const NON_FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
  'web_search',
  'web_fetch',
  'memory_list',
  'memory_get',
  'memory_search',
  'memory_retrieve',
  'memory_create',
  'memory_update',
  'memory_delete',
  'session_list',
  'session_search',
  'session_read',
  'ask_orchestrator',
  'activate_skill',
  // Starts a read-only explorer.
  'run_explorer',
]);
/** Write to persistent memory: an edit, though not to workspace files. */
const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(['memory_create', 'memory_update', 'memory_delete']);

type OfferedTool = Pick<AnyToolDefinition, 'name' | 'cannotWriteFiles'>;

/**
 * What a child provably cannot do, read from its final offered tools (never its role).
 * Only absence is proof: an offered editor can still be denied every write (an empty write scope,
 * a read-only session), so no text is deleted because a tool was offered. A tool whose policy
 * wrapper refuses every file-changing call (`cannotWriteFiles`, the read-only shell) is not a writer.
 */
function writeCapability(tools: readonly OfferedTool[]) {
  const cannotWriteFiles = tools.every((tool) => NON_FILE_WRITING_TOOLS.has(tool.name) || tool.cannotWriteFiles);
  return {
    cannotWriteFiles,
    /** Nothing to edit with at all: no file writer and no memory writer. */
    cannotEdit: cannotWriteFiles && !tools.some((tool) => MEMORY_WRITE_TOOLS.has(tool.name)),
  };
}

/** Addressed to a child that has an editing tool; deleted when it has nothing to edit with. */
const EDITING_TOOL_SENTENCE =
  'When an in-scope edit is already authorized, perform it with the editing tool without asking again. ';
/**
 * Base-prompt wording about using tools, and its replacement for a child offered no tools at all (the
 * mentor). Each pair names an exact Term2 base-prompt phrase; a phrase that is not found is left as written.
 */
const TOOL_USE_BASE_PHRASES: readonly (readonly [string, string])[] = [
  ['use the available tools deliberately, ', ''],
  ['accurate synthesis, careful tool use, and concise reporting', 'accurate synthesis and concise reporting'],
];
/** The Worktree Hygiene lines addressed to worker roles. */
const WORKER_AUDIENCE_LINE = /^- Worker roles .*(?:\r?\n|$)/gm;
/** Runs to the next `#` or `##` heading (a `###` is a subsection of it) or the end of the file. */
const ASK_ORCHESTRATOR_SECTION = /^## Asking the orchestrator\r?\n[\s\S]*?(?=^#{1,2} |(?![\s\S]))/m;
/** The section's one rule that is not about the tool; it survives the section's deletion. */
const NO_DIRECT_USER_CONTACT = /\bdo not contact the user directly\b/i;

/** Deletes the `ask_orchestrator` section but keeps its standalone "do not contact the user directly". */
function withoutAskOrchestratorSection(roleFile: string): string {
  return roleFile.replace(ASK_ORCHESTRATOR_SECTION, (section) =>
    NO_DIRECT_USER_CONTACT.test(section) ? 'Do not contact the user directly.\n\n' : '',
  );
}

/**
 * Shared prompt text is written for every child. Delete only the parts
 * addressed to a capability this child's offered tools provably lack; never
 * reword, except that a deleted "Asking the orchestrator" section leaves its
 * "do not contact the user directly" standing as one sentence. Unrecognised
 * text is left as written.
 *
 * Every input is Term2-authored: the two fragment files, and a named role's
 * own role file (`roleFile`). Text a parent or user wrote (an agent_spec's
 * constraints, completion criterion and context, project instructions, the
 * skill catalog) is never passed here, so no pattern can match inside it.
 */
function withoutDeadAudienceText(
  text: { skillConflicts: string; worktreeHygiene: string; roleFile: string | undefined },
  tools: readonly OfferedTool[],
) {
  const capability = writeCapability(tools);
  return {
    skillConflicts: capability.cannotEdit
      ? text.skillConflicts.replace(EDITING_TOOL_SENTENCE, '')
      : text.skillConflicts,
    // A child that cannot write files is not a worker.
    worktreeHygiene: capability.cannotWriteFiles
      ? text.worktreeHygiene.replace(WORKER_AUDIENCE_LINE, '').trimEnd()
      : text.worktreeHygiene,
    // The section is about the ask_orchestrator tool, which a foreground child is not offered,
    // except for "do not contact the user directly", which still applies to that child.
    roleFile:
      text.roleFile === undefined || tools.some((tool) => tool.name === 'ask_orchestrator')
        ? text.roleFile
        : withoutAskOrchestratorSection(text.roleFile),
  };
}

function buildAvailableToolGuidance(toolDefinitions: readonly OfferedTool[], searchViaShell: boolean): string {
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
    // Name `read_file` only for a child that was actually offered it.
    lines.push(
      `No dedicated workspace search tool is available. Use ${
        hasTool('read_file') ? '`read_file` and ' : ''
      }provided context where possible.`,
    );
  }

  if (hasTool('read_code_outline') || hasTool('code_context_search')) {
    const codeContextTools = ['read_code_outline', 'code_context_search'].filter(hasTool).map((name) => `\`${name}\``);
    lines.push(`For code structure and symbol context, use: ${codeContextTools.join(', ')}.`);
  } else {
    lines.push('Code-context tools are not available in this run.');
  }

  if (hasTool('read_file')) {
    // "or editing" only for a child that may be able to write files.
    lines.push(
      `Use \`read_file\` for exact file contents before drawing conclusions${
        writeCapability(toolDefinitions).cannotWriteFiles ? '' : ' or editing'
      }.`,
    );
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

/** Build the child prompt from its actual offered tools and execution context.
 * Remote execution omits local project instructions and local memory sections. */
export function buildInstructions(
  definition: SubagentDefinition,
  toolDefinitions: readonly OfferedTool[],
  searchViaShell: boolean,
  settings: ISettingsService,
  executionContext?: ExecutionContext,
  skillsService?: SkillsService,
): string {
  const envInfo = getEnvInfo(settings, executionContext);
  const cwd = executionContext?.getCwd() ?? process.cwd();
  const agentsInstructions = executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

  const basePrompt = resolvePrompt(path.join(PROMPTS_DIR, selectSubagentBasePromptFile(definition.model)));
  // A child with no tools has nothing to use deliberately or carefully.
  const modelPrompt =
    toolDefinitions.length === 0
      ? TOOL_USE_BASE_PHRASES.reduce((text, [phrase, replacement]) => text.replace(phrase, replacement), basePrompt)
      : basePrompt;
  // A named role's instructions are its Term2 role file; any other definition's (an agent_spec
  // child's) were written by its parent and stay exactly as written.
  const roleFile = definition.instructionsSource === 'role-file' ? definition.instructions : undefined;
  const shared = withoutDeadAudienceText(
    {
      skillConflicts: resolvePrompt(path.join(BASE_PROMPT_PATH, 'fragments/skill-instruction-conflicts.md')),
      worktreeHygiene: resolvePrompt(path.join(PROMPTS_DIR, 'worktree-hygiene.md')),
      roleFile,
    },
    toolDefinitions,
  );
  const toolGuidance = buildAvailableToolGuidance(toolDefinitions, searchViaShell);
  const memoryCapability = executionContext?.isRemote()
    ? undefined
    : new MemoryCapabilityBuilder(settings).build({ kind: 'subagent', role: definition.role }, { projectPath: cwd });

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
    shared.skillConflicts,
    shared.worktreeHygiene,
    shared.roleFile ?? definition.instructions,
    memoryCapability?.guidance,
    memoryCapability?.context,
    toolGuidance,
    ...inlineSections,
    `Environment: ${envInfo}${agentsInstructions}${skillsInstructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
