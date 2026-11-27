/** Exact private route/method inventory, including the pinned compatibility aliases. */
import type { AssertionPurpose } from './server-contracts.js';
export type PrivateRoute = {
  purpose: AssertionPurpose;
  legacy?: boolean;
  sessionId?: string;
  /** Path workspace id; the assertion must carry the same one. */
  workspaceId?: string;
  interactionId?: string;
};
export function matchPrivateRoute(method: string, pathname: string): PrivateRoute | null {
  if (method === 'POST' && pathname === '/') return { purpose: 'session_create', legacy: true };
  // GET is canonical for workspace_list; POST is a tested compatibility alias for the pinned BFF wire.
  if ((method === 'GET' || method === 'POST') && pathname === '/private/agent/v1/workspaces')
    return { purpose: 'workspace_list' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/validate')
    return { purpose: 'workspace_candidate_validate' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/browse')
    return { purpose: 'workspace_candidate_browse' };
  if (method === 'POST' && pathname === '/private/agent/v1/workspace/candidates/select')
    return { purpose: 'workspace_candidate_select' };
  const workspace = pathname.match(/^\/private\/agent\/v1\/workspaces\/([A-Za-z0-9_-]{1,256})(\/access)?$/);
  if (workspace && !workspace[2] && method === 'DELETE')
    return { purpose: 'workspace_remove', workspaceId: workspace[1] };
  const workspaceFiles = pathname.match(/^\/private\/agent\/v1\/workspaces\/([A-Za-z0-9_-]{1,256})\/files$/);
  if (workspaceFiles && method === 'GET') return { purpose: 'workspace_files', workspaceId: workspaceFiles[1] };
  if (workspace && workspace[2] && method === 'PUT')
    return { purpose: 'workspace_access_update', workspaceId: workspace[1] };
  if (method === 'GET' && pathname === '/private/agent/v1/models') return { purpose: 'model_list' };
  if (method === 'GET' && pathname === '/private/agent/v1/settings') return { purpose: 'settings_read' };
  if (method === 'PUT' && pathname === '/private/agent/v1/settings') return { purpose: 'settings_write' };
  const credential = pathname.match(/^\/private\/agent\/v1\/credentials\/([A-Za-z0-9_-]{1,256})$/);
  if (credential && method === 'POST') return { purpose: 'credential_write', interactionId: credential[1] };
  if (credential && method === 'DELETE') return { purpose: 'credential_delete', interactionId: credential[1] };
  const oauth = pathname.match(/^\/private\/agent\/v1\/oauth\/([A-Za-z0-9_-]{1,256})\/(login|select)$/);
  if (oauth && method === 'POST')
    return {
      purpose: oauth[2] === 'login' ? 'oauth_login' : 'oauth_select',
      interactionId: `${oauth[1]}\u0000${oauth[2]}`,
    };
  const oauthDelete = pathname.match(
    /^\/private\/agent\/v1\/oauth\/([A-Za-z0-9_-]{1,256})\/accounts\/([A-Za-z0-9_-]{1,256})$/,
  );
  if (oauthDelete && method === 'DELETE')
    return { purpose: 'oauth_delete', interactionId: `${oauthDelete[1]}\u0000${oauthDelete[2]}` };
  if (method === 'GET' && pathname === '/private/agent/v1/providers/presets') return { purpose: 'provider_presets' };
  if (method === 'POST' && pathname === '/private/agent/v1/providers') return { purpose: 'provider_write' };
  const providerDelete = pathname.match(/^\/private\/agent\/v1\/providers\/([A-Za-z0-9_.-]{1,256})$/);
  if (providerDelete && method === 'DELETE') return { purpose: 'provider_delete', interactionId: providerDelete[1] };
  if (method === 'GET' && pathname === '/private/agent/v1/skills') return { purpose: 'skills_list' };
  if (method === 'POST' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_create' };
  if (method === 'GET' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_list' };
  const match = pathname.match(
    /^\/private\/agent\/v1\/sessions\/([A-Za-z0-9_-]{1,256})(?:\/(messages|abort|events|config|commands|rewind-targets|rewind|queue|tasks|files|quota|goal|interactions\/([A-Za-z0-9_:-]{1,256})))?$/,
  );
  if (!match) return null;
  const sessionId = match[1]!;
  if (method === 'POST' && !match[2]) return { purpose: 'session_read', sessionId };
  if (method === 'POST' && match[2] === 'messages') return { purpose: 'message_submit', sessionId };
  if (method === 'POST' && match[2] === 'abort') return { purpose: 'abort', sessionId };
  if (method === 'GET' && match[2] === 'events') return { purpose: 'events_connect', sessionId };
  if (method === 'POST' && match[2] === 'config') return { purpose: 'session_update', sessionId };
  if (method === 'POST' && match[2] === 'commands') return { purpose: 'command_invoke', sessionId };
  if (method === 'GET' && match[2] === 'rewind-targets') return { purpose: 'session_rewind_targets', sessionId };
  if (method === 'POST' && match[2] === 'rewind') return { purpose: 'session_rewind', sessionId };
  if (method === 'POST' && match[2] === 'queue') return { purpose: 'session_queue', sessionId };
  if (method === 'POST' && match[2] === 'tasks') return { purpose: 'session_task_control', sessionId };
  if (method === 'GET' && match[2] === 'files') return { purpose: 'session_files', sessionId };
  if (method === 'GET' && match[2] === 'quota') return { purpose: 'session_quota', sessionId };
  if (method === 'POST' && match[2] === 'goal') return { purpose: 'session_goal', sessionId };
  if (method === 'POST' && match[2]?.startsWith('interactions/'))
    return { purpose: 'interaction_resolve', sessionId, interactionId: match[3] };
  return null;
}
