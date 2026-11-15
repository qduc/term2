import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FileReadAccessPort, NestedReadAccessPort } from '../access-port.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import { getDiscoveredSkillRoots } from '../../shared/utils/skill-discovery-paths.js';
import { resolveWorkspacePath, resolveWorkspacePathPhysically } from '../utils.js';

function isWithin(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return targetPath === normalizedRoot || targetPath.startsWith(rootPrefix);
}

async function isInsideDiscoveredSkillRoot(target: string, resolvedPath: string, root: string): Promise<boolean> {
  const home = homedir();
  const realHome = await realpath(home).catch(() => home);
  const roots = new Set([...getDiscoveredSkillRoots(root, home), ...getDiscoveredSkillRoots(root, realHome)]);
  for (const skillRoot of roots) {
    const physicalRoot = await realpath(skillRoot).catch(() => skillRoot);
    if (isWithin(target, physicalRoot)) return true;
    for (const candidateRoot of [skillRoot, physicalRoot]) {
      if (!isWithin(resolvedPath, candidateRoot)) continue;
      const rel = path.relative(candidateRoot, resolvedPath);
      const firstSegment = rel.split(path.sep)[0];
      if (!firstSegment || firstSegment === '..') continue;
      const physicalEntry = await realpath(path.join(candidateRoot, firstSegment)).catch(() => undefined);
      if (physicalEntry && isWithin(target, physicalEntry)) return true;
    }
  }
  return false;
}

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
    if (!remote && (await isInsideDiscoveredSkillRoot(target, resolvedPath, root))) return true;
    resolveWorkspacePath(target, root, { allowDiscoveredSkillFolders: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `readAccess` an edit tool is given for its nearest-line hint, or undefined when the agent has no read
 * capability (`enabled` false): the file must be one this agent could read without asking
 * (isReadPreApproved), and inside its read scope when it has one (`inScope`, the caller's scope check).
 */
export function createHintReadAccess(
  deps: Omit<Parameters<typeof isReadPreApproved>[0], 'path' | 'context'> & {
    enabled: boolean;
    inScope?: (absolutePath: string) => Promise<boolean>;
  },
): ((absolutePath: string, context: unknown) => Promise<boolean>) | undefined {
  const { enabled, inScope, ...rest } = deps;
  if (!enabled) return undefined;
  return async (absolutePath, context) =>
    (await isReadPreApproved({ ...rest, path: absolutePath, context })) && (!inScope || (await inScope(absolutePath)));
}
