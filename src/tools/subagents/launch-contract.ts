/** Alias syntax shared by schema validation and the host-owned registry. */
export const SUBAGENT_RUN_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type SubagentRegistryErrorCode =
  | 'not_found'
  | 'role_mismatch'
  | 'not_continuable'
  | 'already_active'
  | 'worker_blocked'
  | 'evicted'
  | 'invalid_name'
  | 'name_in_use';

/** A launcher rejection, not a successful background-run handle. */
export class SubagentRegistryError extends Error {
  readonly code: SubagentRegistryErrorCode;
  constructor(code: SubagentRegistryErrorCode, message: string) {
    super(message);
    this.name = 'SubagentRegistryError';
    this.code = code;
  }
}
