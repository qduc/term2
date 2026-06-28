export type SandboxNetworkAccessRequest = {
  host: string;
  port?: number;
};

type SandboxNetworkApprovalHandler = (request: SandboxNetworkAccessRequest) => Promise<boolean>;

let activeHandler: SandboxNetworkApprovalHandler | null = null;

export function registerSandboxNetworkApprovalHandler(handler: SandboxNetworkApprovalHandler | null): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

export async function requestSandboxNetworkApproval(request: SandboxNetworkAccessRequest): Promise<boolean> {
  if (!activeHandler) {
    return false;
  }

  try {
    return await activeHandler(request);
  } catch {
    return false;
  }
}
