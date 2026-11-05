/** Host-owned launch input for a resolved generic agent.
 *
 * Intentionally separate from any runtime runner. A caller must resolve and
 * attenuate the AgentSpec before it can reach this seam; no VM-facing tool
 * accepts this shape.
 */
import type { AgentSpecBoundaryResult } from '../agent-runtime/permission-boundary.js';
import type { ResolvedAgentDefinition } from '../agent-runtime/resolved-agent.js';
import type { ForegroundSubagentApprovalCallback } from '../../tools/subagents/foreground-subagent-lease.js';
import type { SubagentDefinition } from '../../tools/subagents/types.js';

export interface ResolvedSubagentLaunch {
  /** A successful host boundary result, a new runtime definition, or a legacy
   * manager-ready definition retained by compatibility callers. */
  resolvedDefinition: AgentSpecBoundaryResult | ResolvedAgentDefinition | SubagentDefinition;
  /** Boundary results carry their task in `spec.goal`; other definitions need
   * an explicit task. */
  task?: string;
  /** A boundary result's validated worktree is used when this is omitted. */
  worktree?: string;
  authorizedWorktreePath?: string;
  name?: string;
  continue_run_id?: string;
  /** Host-only approval owner for pauses in this awaited foreground child. */
  foregroundChildApproval?: ForegroundSubagentApprovalCallback;
}
