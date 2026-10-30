import { z } from 'zod';
export const POLICY_VERSION = 'adaptive-verification-v1';
const text = z.string().trim().min(1).max(16_384);
export const proposalSchema = z
    .object({
    taskId: text,
    goal: text,
    criteria: z.string().max(16_384),
    revision: text,
    environment: text,
    files: z.array(z.string().min(1).max(4096)).max(512),
    classification: z.enum(['documentation', 'code', 'unknown']),
    evidence: text,
    // Only a host-owned checker may supply this identifier; never a model command.
    quickCheck: z.enum(['diff_whitespace']).optional(),
})
    .strict();
export const ACTIONS = ['skip', 'quick_check', 'independent_verify'];
export const decisionSchema = z
    .object({
    action: z.enum(ACTIONS),
    policyVersion: z.literal(POLICY_VERSION),
    reason: text,
    confidence: z.number().finite().min(0).max(1).optional(),
    model: z.string().optional(),
    recommendedAction: z.enum(ACTIONS).optional(),
    auditedSkip: z.boolean().optional(),
    costUsdMicros: z.number().finite().nonnegative().optional(),
})
    .strict();
export const reportSchema = z
    .object({
    outcome: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'TIMEOUT']),
    evidence: text,
    checked: z.array(text).min(1).max(64),
    limitations: z.array(text).max(64),
    verifierVersion: text,
    attemptId: text,
    revision: text,
    costUsdMicros: z.number().finite().nonnegative().optional(),
})
    .strict();
export const budgetsSchema = z
    .object({
    maxRepairs: z.number().int().min(0).max(10),
    maxGateAttempts: z.number().int().positive().max(20),
    maxVerifications: z.number().int().positive().max(20),
    taskTimeoutMs: z.number().int().positive(),
    operationTimeoutMs: z.number().int().positive(),
    gateTimeoutMs: z.number().int().positive(),
})
    .strict();
export const DEFAULT_BUDGETS = {
    maxRepairs: 3,
    maxGateAttempts: 4,
    maxVerifications: 4,
    taskTimeoutMs: 30 * 60_000,
    operationTimeoutMs: 120_000,
    gateTimeoutMs: 10_000,
};
export const recordSchema = z.object({
    taskId: text,
    contract: text,
    revision: text,
    state: z.enum(['VERIFICATION_PENDING', 'REPAIR_REQUIRED', 'COMPLETED', 'BLOCKED', 'ESCALATED']),
    generation: z.number().int().nonnegative(),
    attemptId: text,
    owner: text,
    epoch: text,
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    gateLatencyMs: z.number().finite().nonnegative().optional(),
    verificationLatencyMs: z.number().finite().nonnegative().optional(),
    deadline: z.number().finite(),
    operationDeadline: z.number().finite(),
    repairs: z.number().int().nonnegative(),
    gates: z.number().int().nonnegative(),
    verifications: z.number().int().nonnegative(),
    budgets: budgetsSchema,
    decision: decisionSchema.optional(),
    report: reportSchema.optional(),
    reason: text,
});
//# sourceMappingURL=contracts.js.map