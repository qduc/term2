export type SandboxNetworkAccessRequest = {
  host: string;
  port?: number;
};

type SandboxNetworkApprovalHandler = (request: SandboxNetworkAccessRequest) => Promise<boolean>;

type SandboxNetworkApprovalPauseController = {
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
};

let activeHandler: SandboxNetworkApprovalHandler | null = null;
let activePauseController: SandboxNetworkApprovalPauseController | null = null;

export function registerSandboxNetworkApprovalHandler(handler: SandboxNetworkApprovalHandler | null): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

export function registerSandboxNetworkApprovalPauseController(
  controller: SandboxNetworkApprovalPauseController | null,
): () => void {
  activePauseController = controller;
  return () => {
    if (activePauseController === controller) {
      activePauseController = null;
    }
  };
}

async function pauseActiveSandboxedCommand(): Promise<void> {
  try {
    await activePauseController?.pause();
  } catch {
    // Approval must still be shown even if process suspension is unavailable.
  }
}

async function resumeActiveSandboxedCommand(): Promise<void> {
  try {
    await activePauseController?.resume();
  } catch {
    // Ignore resume errors; the shell execution path still owns process cleanup.
  }
}

export async function requestSandboxNetworkApproval(request: SandboxNetworkAccessRequest): Promise<boolean> {
  if (!activeHandler) {
    return false;
  }

  await pauseActiveSandboxedCommand();
  try {
    return await activeHandler(request);
  } catch {
    return false;
  } finally {
    await resumeActiveSandboxedCommand();
  }
}
