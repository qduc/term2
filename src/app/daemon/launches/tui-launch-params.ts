/**
 * The launch parameters the daemon TUI sends: at startup, for `/resume`, and when it reattaches after
 * its connection dropped. The daemon's launch gate (`launch-gate.ts`) holds each attach to them.
 */
import type { RemoteDirectHost } from '../../../host/daemon/remote-direct-host.js';
import { ClientApiRpcError } from '../../../host/daemon/daemon-errors.js';
import type { SessionLaunchParams } from '../../../protocol/client-api/client-api-schema.js';
import type { DirectLaunchRequest } from '../../launch-types.js';

export type InteractiveRequest = Extract<DirectLaunchRequest, { readonly kind: 'interactive' }>;

function isLaunchOverrideSource(source: string | undefined): boolean {
  return source === 'cli' || source === 'env';
}

export function buildLaunchParams(request: InteractiveRequest, root: string): SessionLaunchParams {
  const { settings } = request.selection;
  const selection: SessionLaunchParams['selection'] =
    request.resumeId === undefined
      ? { kind: 'new' }
      : request.fork
      ? { kind: 'fork', sessionId: request.resumeId }
      : { kind: 'resume', sessionId: request.resumeId };

  const cliModel =
    request.resumeConfiguration?.model ??
    (isLaunchOverrideSource(settings.getSource?.('agent.modelSelection'))
      ? settings.get('agent.modelSelection')
      : undefined);
  const cliReasoning =
    request.resumeConfiguration?.reasoning ??
    (isLaunchOverrideSource(settings.getSource?.('agent.reasoningEffort'))
      ? settings.get('agent.reasoningEffort')
      : undefined);
  const cliApproval = isLaunchOverrideSource(settings.getSource?.('shell.autoApproveMode'))
    ? settings.get('shell.autoApproveMode')
    : undefined;
  const cliShowReview = isLaunchOverrideSource(settings.getSource?.('shell.showReview'))
    ? settings.get('shell.showReview')
    : undefined;
  const cliSandbox = isLaunchOverrideSource(settings.getSource?.('sandbox.enabled'))
    ? settings.get('sandbox.enabled')
    : undefined;

  return {
    cwd: root,
    selection,
    clientMode: 'interactive',
    ...(cliModel ? { model: { provider: cliModel.provider, model: cliModel.model } } : {}),
    ...(cliReasoning ? { reasoning: cliReasoning } : {}),
    ...(request.profileExplicit
      ? { profileId: String(settings.get('app.activeProfileId')), profileExplicit: true }
      : {}),
    ...(cliApproval ? { approvalMode: cliApproval } : {}),
    ...(cliShowReview !== undefined ? { showReview: cliShowReview } : {}),
    ...(cliSandbox !== undefined ? { sandboxEnabled: cliSandbox } : {}),
    ...(request.goal
      ? {
          goal: {
            text: request.goal.outcome,
            ...(request.goal.successCriteria ? { successCriteria: request.goal.successCriteria } : {}),
          },
        }
      : {}),
  };
}

/** The launch gate refused: the session runs looser than asked and is in use, or is another workspace's. */
export function isLaunchRefusal(error: unknown): boolean {
  return error instanceof ClientApiRpcError && (error.code === 'busy' || error.code === 'forbidden');
}

/**
 * Re-admits a session this TUI had open through the same launch gate as `/resume`, before it reattaches
 * after its connection dropped. The approval mode and sandbox it last saw travel as explicit values, so
 * settings it carried (from `/clear`, say) survive a reopen, and a session another launch reopened
 * looser meanwhile is reopened as it was, or refused while that other client still uses it.
 */
export async function readmitDaemonTuiSession(
  host: Pick<RemoteDirectHost, 'launchSession'>,
  root: string,
  sessionId: string,
  last: { getDynamic(key: string): unknown } | null,
): Promise<void> {
  const approvalMode = last?.getDynamic('shell.autoApproveMode');
  const sandboxEnabled = last?.getDynamic('sandbox.enabled');
  await host.launchSession({
    cwd: root,
    selection: { kind: 'resume', sessionId },
    clientMode: 'interactive',
    ...(typeof approvalMode === 'string' ? { approvalMode: approvalMode as SessionLaunchParams['approvalMode'] } : {}),
    ...(typeof sandboxEnabled === 'boolean' ? { sandboxEnabled } : {}),
  });
}

/** A `/resume` target's launch: only the posture flags, so the session keeps its own model, profile and goal. */
export function resumeLaunchParams(request: InteractiveRequest, root: string, sessionId: string): SessionLaunchParams {
  const { clientMode, approvalMode, showReview, sandboxEnabled } = buildLaunchParams(request, root);
  return {
    cwd: root,
    selection: { kind: 'resume', sessionId },
    clientMode,
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(showReview !== undefined ? { showReview } : {}),
    ...(sandboxEnabled !== undefined ? { sandboxEnabled } : {}),
  };
}
