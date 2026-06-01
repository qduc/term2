import path from 'node:path';
import process from 'process';
import { localBindMountStrategy, mount } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient, type UnixLocalSandboxSession } from '@openai/agents/sandbox/local';
import type { ISSHService } from './service-interfaces.js';

type SandboxClientLike = Pick<UnixLocalSandboxClient, 'create'>;

export interface ExecutionContextOptions {
  sandboxClientFactory?: () => SandboxClientLike;
}

export class ExecutionContext {
  private sandboxClient: SandboxClientLike | null = null;
  private sandboxSession: UnixLocalSandboxSession | null = null;
  private sandboxSessionPromise: Promise<UnixLocalSandboxSession> | null = null;

  constructor(
    private readonly sshService?: ISSHService,
    private readonly remoteDir?: string,
    private readonly options: ExecutionContextOptions = {},
  ) {}

  isRemote(): boolean {
    return !!this.sshService;
  }

  isSandboxAvailable(): boolean {
    return !this.isRemote() && process.platform !== 'win32';
  }

  getSSHService(): ISSHService | undefined {
    return this.sshService;
  }

  getCwd(): string {
    if (this.isRemote() && this.remoteDir) {
      return this.remoteDir;
    }
    return process.cwd();
  }

  getSandboxWorkdir(): string {
    return this.getSandboxWorkspaceSpec().mountName;
  }

  async getOrCreateSandboxSession(): Promise<UnixLocalSandboxSession> {
    if (!this.isSandboxAvailable()) {
      throw new Error('Local sandbox is unavailable in SSH mode');
    }

    if (this.sandboxSession) {
      return this.sandboxSession;
    }

    if (!this.sandboxSessionPromise) {
      const creation = this.createSandboxSession().then((session) => {
        this.sandboxSession = session;
        return session;
      });

      this.sandboxSessionPromise = creation;
      try {
        return await creation;
      } finally {
        if (this.sandboxSessionPromise === creation) {
          this.sandboxSessionPromise = null;
        }
      }
    }

    return await this.sandboxSessionPromise;
  }

  async closeSandboxSession(): Promise<void> {
    const pending = this.sandboxSessionPromise;
    if (pending) {
      try {
        await pending;
      } catch {
        // Ignore creation failures during cleanup.
      }
    }

    const session = this.sandboxSession;
    this.sandboxSession = null;
    this.sandboxSessionPromise = null;

    if (!session) {
      return;
    }

    await this.closeSandboxSessionInstance(session);
  }

  private getSandboxClient(): SandboxClientLike {
    if (!this.sandboxClient) {
      this.sandboxClient = this.options.sandboxClientFactory?.() ?? new UnixLocalSandboxClient();
    }

    return this.sandboxClient;
  }

  private getSandboxWorkspaceSpec(): { manifestRoot: string; mountName: string; sourcePath: string } {
    const sourcePath = path.resolve(this.getCwd());
    const mountName = path.basename(sourcePath) || 'workspace';
    const manifestRoot = path.dirname(sourcePath) || path.sep;

    return { manifestRoot, mountName, sourcePath };
  }

  private async createSandboxSession(): Promise<UnixLocalSandboxSession> {
    const client = this.getSandboxClient();
    const { manifestRoot, mountName, sourcePath } = this.getSandboxWorkspaceSpec();

    return await client.create({
      manifest: {
        root: manifestRoot,
        entries: {
          [mountName]: mount({
            source: sourcePath,
            mountPath: mountName,
            readOnly: false,
            mountStrategy: localBindMountStrategy(),
          }),
        },
      },
    });
  }

  private async closeSandboxSessionInstance(session: UnixLocalSandboxSession): Promise<void> {
    const closeOperations: Array<() => Promise<void>> = [];

    if (session.close) {
      closeOperations.push(() => session.close());
    }
    if (session.shutdown) {
      closeOperations.push(() => session.shutdown());
    }
    if (session.delete) {
      closeOperations.push(() => session.delete());
    }
    if (session.stop) {
      closeOperations.push(() => session.stop());
    }

    for (const close of closeOperations) {
      try {
        await close();
        return;
      } catch {
        // Try the next cleanup hook.
      }
    }
  }
}
