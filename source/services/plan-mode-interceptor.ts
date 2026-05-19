import type { ISettingsService } from './service-interfaces.js';

type ToolInterceptor = (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;

type InterceptorCapableClient = {
  addToolInterceptor: (interceptor: ToolInterceptor) => () => void;
};

export const installPlanModeInterceptor = (
  agentClient: InterceptorCapableClient,
  deps: { settingsService: ISettingsService },
): (() => void) => {
  // Subagent roles that cannot mutate the workspace (canWrite: false). The
  // `worker` role (and any future write-capable/custom role) is blocked.
  const READ_ONLY_SUBAGENT_ROLES = new Set(['explorer', 'researcher', 'mentor']);

  const extractRole = (params: unknown): string | undefined => {
    let obj = params;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        return undefined;
      }
    }
    const role = (obj as { role?: unknown } | null)?.role;
    return typeof role === 'string' ? role : undefined;
  };

  const interceptor: ToolInterceptor = async (name: string, params: unknown) => {
    const isPlanMode = deps.settingsService.get<boolean>('app.planMode');
    if (!isPlanMode) {
      return null;
    }

    if (['create_file', 'search_replace', 'apply_patch'].includes(name)) {
      return `Plan mode is active (read-only). The "${name}" tool is disabled. Do not attempt file or state changes — investigate with read-only tools and present an ordered implementation plan. Tell the user to exit plan mode to execute it.`;
    }

    if (name === 'run_subagent') {
      const role = extractRole(params);
      // Allow only read-only subagent roles; block worker and unknown roles
      // (an unknown role could be a write-capable custom subagent).
      if (!role || !READ_ONLY_SUBAGENT_ROLES.has(role)) {
        return `Plan mode is active (read-only). The "run_subagent" tool is restricted to read-only roles (explorer, researcher, mentor) — the "${
          role ?? 'unknown'
        }" role is disabled. Use a read-only subagent to investigate, then present an ordered implementation plan. Tell the user to exit plan mode to execute it.`;
      }
    }

    return null;
  };

  return agentClient.addToolInterceptor(interceptor);
};
