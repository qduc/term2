import path from 'node:path';
import fs from 'node:fs';
import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentRole, SubagentDefinition } from './types.js';
import type { ToolDefinition } from '../../tools/types.js';
import { shouldPreferPatchEditingModel } from '../../lib/tool-selection-policy.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import type { ExecutionContext } from '../execution-context.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, '../../prompts');
export const PROMPTS_DIR = path.join(BASE_PROMPT_PATH, 'subagents');

const ROLE_MAX_TURNS_DEFAULT = 20;

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

  const resolve = (value: any, subagentKey: string, fallbackKey: string | undefined, defaultValue: any): any => {
    if (value === 'inherit' || value === undefined || value === null || value === '') {
      const subagentVal = settings.get(subagentKey);
      if (subagentVal !== undefined && subagentVal !== null) {
        return subagentVal;
      }
      if (fallbackKey) {
        return settings.get(fallbackKey) ?? defaultValue;
      }
      return defaultValue;
    }
    return value;
  };

  return {
    role,
    name: frontmatter.name ?? role,
    instructions: body,
    canRead: frontmatter.canRead ?? false,
    canWrite: frontmatter.canWrite ?? false,
    canSearchWeb: frontmatter.canSearchWeb ?? false,
    canRunShell: frontmatter.canRunShell ?? false,
    maxTurns: frontmatter.maxTurns ?? ROLE_MAX_TURNS_DEFAULT,
    model: resolve(frontmatter.model, `${subagentPrefix}Model`, 'agent.model', 'gpt-4o'),
    provider: resolve(frontmatter.provider, `${subagentPrefix}Provider`, 'agent.provider', 'openai'),
    reasoningEffort: resolve(frontmatter.reasoningEffort, `${subagentPrefix}ReasoningEffort`, undefined, 'default'),
    description: frontmatter.description ?? '',
  };
}

export function selectSubagentBasePromptFile(model: string): string {
  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes('gpt-5') && normalizedModel.includes('codex')) {
    return 'base-codex.md';
  }
  if (normalizedModel.includes('sonnet') || normalizedModel.includes('haiku')) {
    return 'base-anthropic.md';
  }
  if (normalizedModel.includes('gpt-5')) {
    return 'base-gpt-5-modern.md';
  }
  return 'base-simple.md';
}

export function resolveSubagentSearchViaShell(
  settings: ISettingsService,
  model: string,
  canRunShell: boolean,
): boolean {
  const searchViaShellSetting = settings.get<'auto' | 'on' | 'off'>('app.searchViaShell') ?? 'auto';
  if (searchViaShellSetting === 'on') return canRunShell;
  if (searchViaShellSetting === 'off') return false;
  return shouldPreferPatchEditingModel(model) && canRunShell;
}

export function buildAvailableToolGuidance(toolDefinitions: ToolDefinition[], searchViaShell: boolean): string {
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
  toolDefinitions: ToolDefinition[],
  searchViaShell: boolean,
  settings: ISettingsService,
  executionContext?: ExecutionContext,
): string {
  const envInfo = getEnvInfo(settings, executionContext);
  const cwd = executionContext?.getCwd() ?? process.cwd();
  const agentsInstructions = executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

  const modelPrompt = resolvePrompt(path.join(PROMPTS_DIR, selectSubagentBasePromptFile(definition.model)));
  const worktreeHygiene = resolvePrompt(path.join(PROMPTS_DIR, 'worktree-hygiene.md'));
  const toolGuidance = buildAvailableToolGuidance(toolDefinitions, searchViaShell);

  return [
    modelPrompt,
    worktreeHygiene,
    definition.instructions,
    toolGuidance,
    `Environment: ${envInfo}${agentsInstructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
