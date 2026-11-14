import type { FileReadAccessPort, NestedReadAccessPort } from '../access-port.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import { resolveWorkspacePath, resolveWorkspacePathPhysically } from '../utils.js';

/** Prefer root-bound authority; only legacy nested calls consult their session-keyed grant. */
export function isSessionReadGranted(
  resolvedPath: string,
  cwd: string,
  context: unknown,
  deps: { sessionAccess?: FileReadAccessPort; nestedCompatibility?: NestedReadAccessPort },
): boolean {
  if (deps.sessionAccess) return deps.sessionAccess.allowsRead(resolvedPath, cwd);
  const sessionId = getSessionIdFromToolContext(context);
  return !!sessionId && !!deps.nestedCompatibility?.allowsRead(sessionId, resolvedPath, cwd);
}

function getSessionIdFromToolContext(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const runContext = context as { context?: unknown };
  if (!runContext.context || typeof runContext.context !== 'object') return null;
  const sessionId = (runContext.context as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

/**
 * True when `read_file` would read `targetPath` without asking the user: the setting that approves reads
 * is on, `allowOutsideWorkspace` is set, the path is physically inside the workspace (or a discovered skill
 * folder), or the session holds a read grant for it. This is the one read-authority rule; `read_file`'s
 * `needsApproval` is its negation, and tools that would otherwise echo file content (the nearest-line hint)
 * ask it before doing so.
 */
export async function isReadPreApproved(params: {
  path: string;
  context: unknown;
  executionContext?: ExecutionContext;
  allowOutsideWorkspace?: boolean;
  settingsService?: Pick<ISettingsService, 'get'>;
  sessionAccess?: FileReadAccessPort;
  nestedCompatibility?: NestedReadAccessPort;
}): Promise<boolean> {
  if (params.allowOutsideWorkspace) return true;
  // YOLO mode ('always') approves read-only operations without a prompt, even outside the workspace.
  if (params.settingsService?.get('shell.autoApproveMode') === 'always') return true;
  try {
    const { executionContext } = params;
    const cwd = executionContext?.getCwd() || process.cwd();
    const resolvedPath = resolveWorkspacePath(params.path, cwd, { allowOutsideWorkspace: true });
    // A lexical workspace path can point outside through a symlink. Never resolve an SSH path against
    // this host's filesystem.
    const remote = executionContext?.isRemote() ?? false;
    const target = remote ? resolvedPath : await resolveWorkspacePathPhysically(resolvedPath, cwd);
    const root = remote ? cwd : await resolveWorkspacePathPhysically(cwd, cwd);
    if (!target || !root) return false;
    if (isSessionReadGranted(target, root, params.context, params)) return true;
    resolveWorkspacePath(target, root, { allowDiscoveredSkillFolders: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `readAccess` an edit tool is given for its nearest-line hint: the file must be one this agent could
 * read without asking (isReadPreApproved), and inside its read scope when it has one.
 */
export function createHintReadAccess(
  deps: Omit<Parameters<typeof isReadPreApproved>[0], 'path' | 'context'> & {
    inScope?: (absolutePath: string) => Promise<boolean>;
  },
): (absolutePath: string, context: unknown) => Promise<boolean> {
  const { inScope, ...rest } = deps;
  return async (absolutePath, context) =>
    (await isReadPreApproved({ ...rest, path: absolutePath, context })) && (!inScope || (await inScope(absolutePath)));
}
