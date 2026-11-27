import { AsyncResource } from 'node:async_hooks';
import type { ToolContext } from '../../index.js';
import { isHostAllowed, setProjectNetworkApproval } from './sandbox-network-store.js';
import { isSandboxNetworkHost, isSandboxNetworkPort } from './sandbox-network-validation.js';

export const SANDBOX_NETWORK_INTERACT = Symbol('sandboxNetworkInteract');

export type SandboxNetworkAccessRequest = {
  host: string;
  port?: number;
};

export type NetworkApprovalAnswer = 'deny' | 'allow-once' | 'allow-session' | 'allow-project' | boolean;

type SandboxNetworkApprovalHandler = (request: SandboxNetworkAccessRequest) => Promise<NetworkApprovalAnswer>;

export type SandboxNetworkApprovalPauseController = {
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
};

type CommandNetworkApprovals = {
  readonly handler: SandboxNetworkApprovalHandler;
  readonly pending: Map<string, Promise<boolean>>;
  readonly allowed: Set<string>;
  readonly ended: Promise<void>;
  queue: Promise<unknown>;
};

export type SandboxNetworkApprovalScope = {
  registerHandler(handler: SandboxNetworkApprovalHandler): () => void;
  registerPauseController(controller: SandboxNetworkApprovalPauseController | null): () => void;
  requestApproval(request: SandboxNetworkAccessRequest, workspaceRoot: string): Promise<boolean>;
};

export function createSandboxNetworkApprovalScope(): SandboxNetworkApprovalScope {
  let activeCommand: CommandNetworkApprovals | undefined;
  let activePauseController: SandboxNetworkApprovalPauseController | null = null;

  const pauseCommand = async (): Promise<void> => {
    try {
      await activePauseController?.pause();
    } catch {
      // Approval must still be shown even if process suspension is unavailable.
    }
  };

  const resumeCommand = async (): Promise<void> => {
    try {
      await activePauseController?.resume();
    } catch {
      // Ignore resume errors; the shell execution path still owns process cleanup.
    }
  };

  return {
    registerHandler(handler: SandboxNetworkApprovalHandler): () => void {
      let end!: () => void;
      const ended = new Promise<void>((resolve) => {
        end = resolve;
      });
      const command: CommandNetworkApprovals = {
        handler: AsyncResource.bind(handler),
        pending: new Map<string, Promise<boolean>>(),
        allowed: new Set<string>(),
        queue: Promise.resolve(),
        ended,
      };
      activeCommand = command;
      return () => {
        if (activeCommand === command) activeCommand = undefined;
        end();
      };
    },

    registerPauseController(controller: SandboxNetworkApprovalPauseController | null): () => void {
      activePauseController = controller;
      return () => {
        if (activePauseController === controller) {
          activePauseController = null;
        }
      };
    },

    async requestApproval(request: SandboxNetworkAccessRequest, workspaceRoot: string): Promise<boolean> {
      if (!isSandboxNetworkHost(request.host) || !isSandboxNetworkPort(request.port)) return false;
      if (isHostAllowed(request.host, request.port, workspaceRoot)) {
        return true;
      }

      const command = activeCommand;
      if (!command) return false;
      const port = request.port;
      const destination = JSON.stringify([request.host.toLowerCase(), port]);
      if (command.allowed.has(destination)) return true;
      const existing = command.pending.get(destination);
      if (existing) return existing;

      const decision = command.queue.then(async () => {
        if (activeCommand !== command) return false;
        const pauseController = activePauseController;
        await pauseCommand();
        try {
          if (activeCommand !== command) return false;
          const answer = await Promise.race([command.handler(request), command.ended]);
          if (activeCommand !== command) return false;
          if (answer === 'allow-project') {
            setProjectNetworkApproval(workspaceRoot, request.host, port, true);
          } else if (answer !== true && answer !== 'allow-once') {
            return false;
          }
          command.allowed.add(destination);
          return true;
        } catch {
          return false;
        } finally {
          command.pending.delete(destination);
          if (activePauseController === pauseController) await resumeCommand();
        }
      });
      command.pending.set(destination, decision);
      command.queue = decision;
      return decision;
    },
  };
}

const defaultScope = createSandboxNetworkApprovalScope();

export function registerSandboxNetworkApprovalPauseController(
  controller: SandboxNetworkApprovalPauseController | null,
): () => void {
  return defaultScope.registerPauseController(controller);
}

export async function requestSandboxNetworkApproval(
  request: SandboxNetworkAccessRequest,
  workspaceRoot: string,
  scope: SandboxNetworkApprovalScope = defaultScope,
): Promise<boolean> {
  return scope.requestApproval(request, workspaceRoot);
}

export function beginForegroundSandboxNetworkApproval(
  context: unknown,
  signal?: AbortSignal,
  scope: SandboxNetworkApprovalScope = defaultScope,
): { dispose: () => void; annotateFailure: (output: string) => string } | undefined {
  const interact = (context as { [SANDBOX_NETWORK_INTERACT]?: ToolContext['interact'] } | undefined)?.[
    SANDBOX_NETWORK_INTERACT
  ];
  if (!interact) return undefined;
  let deniedDestination: string | undefined;
  const dispose = scope.registerHandler(async ({ host, port }) => {
    const target = port === undefined ? host : `${host}:${port}`;
    const decision = await interact({
      kind: 'approval',
      toolName: 'sandbox_network_access',
      input: { host, port },
      summary: `Allow network access to ${target}?`,
      grants: ['network-allow-once', 'allow-project'],
    });
    if (signal?.aborted) return 'deny';
    if (decision.kind === 'allow' && decision.grant === 'allow-project') return 'allow-project';
    if (decision.kind === 'allow' && decision.grant === 'network-allow-once') return 'allow-once';
    deniedDestination = target;
    return 'deny';
  });
  return {
    dispose,
    annotateFailure: (output) =>
      deniedDestination
        ? `${output}\nSandbox network permission was not granted for ${deniedDestination}. Retry in a foreground session to approve this destination.`
        : output,
  };
}
