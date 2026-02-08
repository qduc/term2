import { ISSHService } from './service-interfaces.js';
import process from 'process';

export class ExecutionContext {
  constructor(private readonly sshService?: ISSHService, private readonly remoteDir?: string) {}

  isRemote(): boolean {
    return !!this.sshService;
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
}
