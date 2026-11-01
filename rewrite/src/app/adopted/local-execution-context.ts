/** Native Session home/lease; never publishes the frozen CLI's process-wide root. */
import path from 'node:path';
import { ExecutionContext } from '../../../../source/services/execution-context.js';

export class LocalExecutionContext extends ExecutionContext {
  private lease?: string;

  constructor(private readonly home: string) {
    super();
    if (!path.isAbsolute(home)) throw new Error(`Workspace home must be absolute: ${home}`);
  }

  override getCwd(): string {
    return this.lease ?? this.home;
  }

  override getHomeWorkspace(): string {
    return this.home;
  }

  override getActiveWorkspace(): string | undefined {
    return this.lease;
  }

  override enterWorkspace(root: string): void {
    if (!path.isAbsolute(root)) throw new Error(`Active workspace must be an absolute path, received: ${root}`);
    this.lease = root;
  }

  override exitWorkspace(): void {
    this.lease = undefined;
  }
}
