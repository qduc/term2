/**
 * Everything the old agent builder decides about a request: instructions, tool
 * specs and generation settings. Calls source `buildAgent` with throwing stubs
 * for runtime callbacks, and never executes a tool (D1).
 */

import { z } from 'zod';
import { buildAgent } from '../../../source/lib/agent-factory.js';
import { createEditorImpl } from '../../../source/lib/editor-impl.js';
import { getCatalogModel } from '../../../source/providers/model-catalog/catalog.js';
import { resolveRequestOutput } from '../../../source/services/agent-runtime/model-context-policy.js';
import { ToolApprovalPolicyRegistry } from '../../../source/services/approval/tool-approval-policy-registry.js';
import { ExecutionContext } from '../../../source/services/execution-context.js';
import { primeActiveProfileNoticeIfActive } from '../../../source/services/mode-notices.js';
import { SkillsService } from '../../../source/services/skills/skills-service.js';
import { isZodToolParameterSchema } from '../../../source/tools/types.js';
import type { ReasoningEffort, ToolSpec } from '../model/index.js';
import type { ProviderRegistryDeps } from '../model/provider.js';

/**
 * Built by `cli.ts`. `settings` was constructed with `disableFilePersistence:
 * true` (D10), and `cli.ts` has already applied the chosen profile to
 * `app.activeProfileId` with `{ persist: false }`.
 */
export type ProfileSelection = ProviderRegistryDeps;

export type AgentSurface = {
  readonly profileName: string;
  readonly instructions: string;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly notice: string | null;
};

type AgentDeps = Parameters<typeof buildAgent>[1];
type AgentTool = ReturnType<typeof buildAgent>['agent']['tools'][number];

/** Stands in for every runtime callback: tools are described here, never run. */
const unavailable = (async () => {
  throw new Error('tools are not available yet');
}) as never;

export function loadSurface({ settings, logger }: ProfileSelection): AgentSurface {
  const selection = settings.get('agent.modelSelection');
  const executionContext = new ExecutionContext();
  const skillsService = new SkillsService(logger, executionContext.getCwd());
  skillsService.discoverSkills();

  const deps = {
    settings,
    logger,
    executionContext,
    editor: createEditorImpl({ loggingService: logger, settingsService: settings, executionContext }),
    providerId: selection.provider,
    serviceTierOverrideForNextRequest: null,
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
    getGoal: () => undefined,
    skillsService,
    createMentor: unavailable,
    runSubagent: unavailable,
    runSubagentAsync: unavailable,
    getSubagentResult: unavailable,
    getSubagentStatus: unavailable,
    sendSubagentMessage: unavailable,
    cancelSubagentRun: unavailable,
    runResolvedSubagent: unavailable,
    runResolvedSubagentAsync: unavailable,
    checkToolInterceptors: async () => null,
    allowBackgroundShell: false,
    allowAskUser: false,
    getAgentRuntime: () => ({
      agent: () => {
        throw new Error('tools are not available yet');
      },
    }),
    configureTaskCheckIn: unavailable,
    setTaskCheckInPolicy: () => {},
  } as unknown as AgentDeps;

  const { agent } = buildAgent({ selection, reasoningEffort: settings.get('agent.reasoningEffort') }, deps);

  const modelSettings = agent.modelSettings;
  const maxOutputTokens = resolveRequestOutput(
    getCatalogModel(selection.provider, agent.model),
    modelSettings?.maxTokens,
  );
  const reasoning = (modelSettings?.reasoning as { effort?: ReasoningEffort } | undefined)?.effort;
  const providerOptions = modelSettings?.providerData as AgentSurface['providerOptions'];
  const temperature = modelSettings?.temperature as number | undefined;

  let notice: string | null = null;
  primeActiveProfileNoticeIfActive(settings, (text) => {
    notice = text;
  });

  return {
    profileName: displayName(String(settings.get('app.activeProfileId'))),
    instructions: agent.resolveInstructionsForRequest?.() ?? String(agent.instructions),
    tools: agent.tools.map(toToolSpec),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    notice,
  };
}

function displayName(profileId: string): string {
  return profileId === 'builtin:standard' ? 'full' : profileId.replace(/^builtin:/, '');
}

function toToolSpec(tool: AgentTool): ToolSpec {
  if (tool.modelTool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {},
      modelTool: tool.modelTool as NonNullable<ToolSpec['modelTool']>,
    };
  }
  const parameters = tool.parameters;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: (isZodToolParameterSchema(parameters)
      ? z.toJSONSchema(parameters)
      : parameters) as ToolSpec['inputSchema'],
  };
}
