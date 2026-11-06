import type { DeniedReadStore, ExecutionOverrideStore } from '../shared/utils/shell/sandbox/denied-read-stores.js';
import type { DockerHostControlGrants } from '../shared/utils/shell/sandbox/docker-host-control-grants.js';

/** Read authority consulted by file tools; grants remain owned by the session. */
export interface FileReadAccessPort {
  allowsRead(targetPath: string, baseDir?: string): boolean;
}

/** Edit authority and creation bookkeeping, not a grant-writing capability. */
export interface FileEditAccessPort {
  readonly isReadOnly: boolean;
  allowsEdit(targetPath: string, baseDir?: string): boolean;
  recordCreatedFile(file: string, baseDir?: string): void;
}

/** Shell's view of session Docker approvals; consuming one-shot grants is intentional. */
export interface ShellAccessPort {
  requiresDockerApproval(command: string): boolean;
  hasDockerProject(cwd: string): boolean;
  hasDockerSessionGrant(cwd: string): boolean;
  hasDockerGrant(command: string, cwd: string): boolean;
  consumeDockerDenial(command: string): boolean;
  recordDockerDenial(command: string): void;
}

/** Legacy nested read authority is session-keyed rather than root-bound. */
export interface NestedReadAccessPort {
  allowsRead(sessionId: string, targetPath: string, baseDir?: string): boolean;
}

/** The shared nested shell compatibility stores needed by execution and approval. */
export interface NestedShellAccessPort {
  readonly deniedReads: Pick<DeniedReadStore, 'peek' | 'record'>;
  readonly executionOverrides: Pick<ExecutionOverrideStore, 'consume'>;
  readonly docker: Pick<
    DockerHostControlGrants,
    'requiresApproval' | 'hasProject' | 'hasSession' | 'consumeOnce' | 'consumeDenial' | 'recordDenial'
  >;
}
