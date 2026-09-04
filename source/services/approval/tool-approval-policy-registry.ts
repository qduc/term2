import { normalizeObjectParams } from '../../lib/tool-invoke.js';

export type ToolApprovalPolicyResult = { kind: 'auto_approve' } | { kind: 'prompt' } | { kind: 'unknown' };

export interface ToolApprovalPolicyRegistration {
  toolName: string;
  parameters?: unknown;
  needsApproval: (params: unknown, context?: unknown) => Promise<boolean> | boolean;
}

export interface ToolApprovalPolicyEvaluation {
  toolName: string;
  args: unknown;
  context?: unknown;
}

export type ToolApprovalDecision = 'allow' | 'deny';

export class ToolApprovalPolicyRegistry {
  readonly #policies = new Map<string, ToolApprovalPolicyRegistration>();

  register(registration: ToolApprovalPolicyRegistration): void {
    this.#policies.set(registration.toolName, registration);
  }

  clear(): void {
    this.#policies.clear();
  }

  async evaluate(evaluation: ToolApprovalPolicyEvaluation): Promise<ToolApprovalPolicyResult> {
    const policy = this.#policies.get(evaluation.toolName);
    if (!policy) {
      return { kind: 'unknown' };
    }

    try {
      const normalized = normalizeObjectParams(evaluation.args, policy.parameters as any);
      const requiresApproval = await policy.needsApproval(normalized, evaluation.context);
      return requiresApproval ? { kind: 'prompt' } : { kind: 'auto_approve' };
    } catch {
      return { kind: 'prompt' };
    }
  }

  /**
   * Resolves the raw policy for a caller that cannot suspend for interactive
   * approval. Only an explicit auto-approval is executable out of band.
   */
  async decide(evaluation: ToolApprovalPolicyEvaluation): Promise<ToolApprovalDecision> {
    const result = await this.evaluate(evaluation);
    return result.kind === 'auto_approve' ? 'allow' : 'deny';
  }
}

export const toolApprovalPolicyRegistry = new ToolApprovalPolicyRegistry();
