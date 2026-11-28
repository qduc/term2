/**
 * Per-session HTTP server presentation port shared by `term2 serve` and the daemon HTTP binding.
 */
import { getProfileLabel } from '../../config/profiles/labels.js';
import { composeHandoffMessage } from '../../shared/handoff/handoff-flow-reducer.js';
import { injectSkillIntoTurn } from '../../shared/types/user-turn.js';
import type { Principal } from '../../host/in-process-direct-types.js';
import type { ServerSessionPresentation } from '../../host/server-contracts.js';
import type { WireSnapshot } from '../../protocol/wire.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { createDurableGoal } from '../../session/goal.js';
import type { DirectApplication } from '../application.js';
import { prepareDirectSessionConfigurationCommand } from '../config-settings.js';
import { scanDirectoryEntries } from '../file-service.js';
import {
  directServeToolPosture,
  type DirectGlobalConfiguration,
  type DirectWorkspaceAuthority,
} from '../host-config.js';

export type ServePresentationOptions = {
  readonly app: DirectApplication;
  readonly grants: DirectWorkspaceAuthority;
  readonly configuration: DirectGlobalConfiguration;
  readonly allowWrite: boolean;
  readonly onSessionCreated?: (sessionId: string) => Promise<void>;
  readonly allowUnboundLocal?: boolean;
  readonly ownerUserId?: string;
  readonly resolveSessionRoot?: (sessionId: string) => string | undefined;
};

export type DirectServeSessionPresentation = ServerSessionPresentation & {
  prepareConfiguration(
    principal: Principal,
    snapshot: WireSnapshot,
    body: unknown,
  ): ReturnType<typeof prepareDirectSessionConfigurationCommand>;
};

export function createServePresentation(options: ServePresentationOptions): DirectServeSessionPresentation {
  const { app, grants, configuration, allowWrite } = options;
  const owned = (principal: Principal, sessionId: string, seq: number | null) => {
    const binding = app.sessionDetails(sessionId, seq).binding;
    if (binding) {
      if (binding.client !== principal.userId) {
        throw new DirectProtocolError('forbidden', 'Workspace grant does not authorize this principal.');
      }
      return { grant: grants.resolveGrant(principal, binding.id) };
    }
    if (options.allowUnboundLocal && options.ownerUserId === principal.userId) {
      const root = options.resolveSessionRoot?.(sessionId);
      if (root) {
        for (const alias of grants.list(principal)) {
          try {
            const grant = grants.resolveGrant(principal, alias.workspaceId);
            const { workspace } = grants.resolveWorkspace(principal, grant);
            if (workspace.target === 'local' && workspace.root === root) return { grant };
          } catch {
            // Skip inaccessible grants.
          }
        }
      }
    }
    throw new DirectProtocolError('forbidden', 'Workspace grant does not authorize this principal.');
  };
  return {
    metadata(principal, snapshot) {
      const { createdAt, updatedAt, earliestSeq } = app.sessionDetails(snapshot.sessionId, snapshot.seq);
      return {
        workspaceId: owned(principal, snapshot.sessionId, snapshot.seq).grant.workspaceId,
        createdAt,
        updatedAt,
        earliestReplayableSequence: earliestSeq,
      };
    },
    async configuration(principal, snapshot) {
      const { grant } = owned(principal, snapshot.sessionId, snapshot.seq);
      const { workspace } = grants.resolveWorkspace(principal, grant);
      const kind = grants.kindOf(grant.workspaceId);
      const current = await app.sessionConfiguration(snapshot.sessionId);
      const { defaultsRevision } = await configuration.read();
      return {
        sessionId: current.sessionId,
        providerId: current.model.provider,
        modelId: current.model.model,
        reasoningEffort: current.reasoningEffort,
        mode: getProfileLabel(current.profileId),
        approvalMode: current.approvalMode,
        toolPolicy: directServeToolPosture(
          workspace.access === 'read_write' && current.workspaceAccess === 'read_write' && allowWrite,
          current.approvalMode !== 'off',
          { allowUnsandboxed: kind !== 'directory', sshEnabled: kind === 'ssh' },
        ),
        configRevision: current.commandRevision,
        defaultsRevision,
      };
    },
    async listFiles(principal, snapshot) {
      const { grant } = owned(principal, snapshot.sessionId, snapshot.seq);
      const { workspace } = grants.resolveWorkspace(principal, grant);
      if (grants.kindOf(grant.workspaceId) !== 'directory') return { entries: [], truncated: true };
      const scanned = await scanDirectoryEntries(workspace.root, { maxDepth: 12, maxTotalEntries: 2_000 });
      return { entries: scanned.entries, truncated: scanned.truncated };
    },
    prepareSkillText(principal, snapshot, skillName, text) {
      const { grant } = owned(principal, snapshot.sessionId, snapshot.seq);
      if (grants.kindOf(grant.workspaceId) === 'ssh') return null;
      const { workspace } = grants.resolveWorkspace(principal, grant);
      const available = app.skills(workspace.root);
      const skill = available.find((candidate) => candidate.name.toLowerCase() === skillName.toLowerCase());
      if (!skill) return null;
      return injectSkillIntoTurn({
        text,
        skill: { name: skill.name, description: skill.description, body: skill.body },
      }).text;
    },
    withApprovalMode(principal, snapshot, approvalMode, operation) {
      owned(principal, snapshot.sessionId, snapshot.seq);
      return app.withApprovalMode(snapshot.sessionId, approvalMode, operation);
    },
    prepareConfiguration(principal, snapshot, body) {
      owned(principal, snapshot.sessionId, snapshot.seq);
      return prepareDirectSessionConfigurationCommand(body, snapshot.model);
    },
    async setGoal(principal, snapshot, action) {
      owned(principal, snapshot.sessionId, snapshot.seq);
      if (action.action === 'clear') {
        await app.setGoal(snapshot.sessionId, undefined, 'user');
        return;
      }
      if (action.action === 'set') {
        await app.setGoal(snapshot.sessionId, createDurableGoal(action.text, action.successCriteria), 'user');
        return;
      }
      if (action.action === 'accept_proposal') {
        const proposal = snapshot.goalProposal;
        if (!proposal) throw new DirectProtocolError('rejected', 'No proposed goal to accept.');
        await app.setGoal(snapshot.sessionId, createDurableGoal(proposal.text, proposal.successCriteria), 'user');
        return;
      }
      const current = await app.goal(snapshot.sessionId);
      if (!current) throw new DirectProtocolError('rejected', 'No durable goal is set.');
      await app.setGoal(
        snapshot.sessionId,
        { ...current, status: action.action === 'achieved' ? 'achieved' : 'abandoned' },
        'user',
      );
    },
    async handoff(principal, snapshot, input) {
      owned(principal, snapshot.sessionId, snapshot.seq);
      const captured = snapshot.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.text)
        .filter((text) => text.length > 0)
        .at(-1);
      if (captured === undefined)
        throw new DirectProtocolError('rejected', 'No assistant response available to hand off.');
      const text = composeHandoffMessage({
        capturedText: captured,
        stage: 'selecting_model',
        ...(input.message ? { handoffMessage: input.message } : {}),
      });
      const sessionId = await app.handoff(snapshot.sessionId, input.model, text);
      await options.onSessionCreated?.(sessionId);
      return { sessionId };
    },
  };
}
