/** Local memory composition; Session remains the only context/admission owner. */
import { AutomaticMemoryCanary } from '../../../source/services/memory/automatic-memory-canary.js';
import {
  MemoryCapabilityBuilder,
  type MemoryCapabilitySubject,
} from '../../../source/services/memory/memory-capabilities.js';
import { resolveActiveProfile } from '../../../source/services/profiles/active-profile.js';
import type { ISettingsService } from '../../../source/services/service-interfaces.js';
import { resolveDisabledCapabilities } from '../../../source/services/tool-toggles.js';
import { isDirectlyCallable, TOOL_NAME_RUN_CODE } from '../../../source/tools/system/run-code/index.js';
import type { AnyToolDefinition } from '../../../source/tools/types.js';
import type { DirectContextCapabilities, DirectContextPort } from '../session/direct-capabilities.js';
import { createDirectAutomaticMemory, createDirectMemoryCapability } from '../session/direct-memory.js';
import type { ToolSpec } from '../model/index.js';
import type { Tool, Workspace } from '../tools/index.js';

export type DirectSessionMemoryOptions = {
  readonly settings: ISettingsService;
  /** Current authorized identity, not a path recovered from session metadata. */
  readonly workspace: Workspace;
  readonly subject: MemoryCapabilitySubject;
  /** Actual base offering: without run_code, source leaves remain directly callable. */
  readonly offeredTools: readonly Pick<ToolSpec, 'name'>[];
  /** The owning surface's adapter, retaining its normal approval/interceptor gates. */
  readonly adaptTool: (definition: AnyToolDefinition) => Tool;
  readonly onWarning?: (message: string) => void;
};

/** True when this profile/settings would actually grant local memory. The prompt
 * may describe that capability even though Session owns the tools and context. */
export function directMainMemoryEnabled(settings: ISettingsService): boolean {
  return (
    resolveActiveProfile(settings).tools.capabilities.has('memory') &&
    !resolveDisabledCapabilities(settings).has('memory')
  );
}

/**
 * Spread into the real Session context factory after replay, with source surface
 * memory disabled (`includeMemory:false`). Reuse source role/profile/settings and
 * shared-worktree store policy, then let Session accept snapshots at its genuine
 * human admission boundary. Nonlocal targets have no local-store fallback.
 */
export function createDirectSessionMemory(
  options: DirectSessionMemoryOptions,
  port: DirectContextPort,
): Pick<DirectContextCapabilities, 'memory' | 'automaticMemory'> {
  // Before profile resolution, store construction, or source-tool adaptation:
  // a remote root with the same spelling never denotes local memory authority.
  if (options.workspace.target !== 'local') return {};

  const { settings, subject } = options;
  let includeContext = false;
  let includeGuidance = true;
  let personalContextOptIn = false;
  if (subject.kind === 'main') {
    const profile = resolveActiveProfile(settings);
    if (!directMainMemoryEnabled(settings)) {
      // Keep the human-admission planner present so it can withdraw an earlier
      // personal snapshot when reopening under a memory-disabled profile.
      return { memory: { access: 'none', tools: [], guidance: '', globalContext: '', facts: [] } };
    }
    const bare = profile.identity.id === 'builtin:bare';
    includeContext = !bare && profile.context.sources.some((source) => source.source === 'memory' && source.enabled);
    personalContextOptIn = bare;
    includeGuidance = !bare;
  }

  const builder = new MemoryCapabilityBuilder(settings, { onWarning: options.onWarning });
  const capability = createDirectMemoryCapability({
    builder,
    adaptTool: options.adaptTool,
    subject,
    projectPath: options.workspace.root,
    state: port.read().memory,
    includeContext,
    personalContextOptIn,
  });
  // Adapt every leaf into run_code before applying the source top-level policy.
  const memory = {
    ...capability,
    tools: options.offeredTools.some((tool) => tool.name === TOOL_NAME_RUN_CODE)
      ? capability.tools.filter((tool) => isDirectlyCallable(tool.spec))
      : capability.tools,
    guidance: includeGuidance ? capability.guidance : '',
  };
  if (subject.kind !== 'main' || memory.access === 'none' || process.env.TERM2_AUTOMATIC_MEMORY_CANARY !== '1') {
    return { memory };
  }

  const automaticMemory = createDirectAutomaticMemory({
    sessionId: port.sessionId,
    canary: new AutomaticMemoryCanary(builder.projectStore(options.workspace.root)),
    allowed: () => settings.get('memory.enabled') === true,
    readState: () => port.read().memory,
    commit: (facts) => port.commit(port.read().goal.generation, facts),
  });
  return { memory, automaticMemory };
}
