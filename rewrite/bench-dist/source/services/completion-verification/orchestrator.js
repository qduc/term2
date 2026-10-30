import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_BUDGETS, POLICY_VERSION, budgetsSchema, decisionSchema, proposalSchema, reportSchema, } from './contracts.js';
import { mandatoryVerification } from './gate.js';
/** A deadline races even a broken adapter that ignores cancellation; late results have no write capability. */
async function bounded(operation, milliseconds, signal) {
    const controller = new AbortController();
    let timer;
    let onAbort;
    try {
        return await Promise.race([
            new Promise((_resolve, reject) => {
                onAbort = () => {
                    controller.abort();
                    reject(new Error('Verification cancelled'));
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('Verification deadline exceeded'));
                }, milliseconds);
                if (signal?.aborted)
                    onAbort();
            }),
            Promise.resolve().then(() => {
                if (controller.signal.aborted)
                    throw new Error('Verification cancelled');
                return operation(controller.signal);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (onAbort)
            signal?.removeEventListener('abort', onAbort);
    }
}
export class CompletionVerificationOrchestrator {
    store;
    operations;
    #owner = randomUUID();
    #active = new Map();
    #budgets;
    constructor(store, operations, budgets = DEFAULT_BUDGETS) {
        this.store = store;
        this.operations = operations;
        this.#budgets = budgetsSchema.parse(budgets);
    }
    configureNewTaskBudgets(budgets) {
        this.#budgets = budgetsSchema.parse(budgets);
    }
    propose(raw, signal) {
        const parsed = proposalSchema.safeParse(raw);
        if (!parsed.success)
            return Promise.resolve({ action: 'blocked', reason: 'Invalid completion proposal' });
        const proposal = parsed.data;
        // Duplicates in one owner share dispatch. Conflicting proposals never share a result.
        const key = JSON.stringify(proposal);
        const active = this.#active.get(key);
        if (active)
            return active;
        const result = this.#run(proposal, signal)
            .catch(() => {
            this.#alert('Completion verification persistence or adapter failure');
            return { action: 'blocked', reason: 'Completion verification failed; completion is not authorized' };
        })
            .finally(() => this.#active.delete(key));
        this.#active.set(key, result);
        return result;
    }
    #alert(message) {
        try {
            this.operations.alert?.(message);
        }
        catch {
            /* Alerts cannot authorize completion. */
        }
    }
    #persist(next, previous) {
        if (!this.store.write(next, previous?.generation))
            throw new Error('Stale verification transition');
        try {
            this.operations.observe?.(next);
        }
        catch {
            this.#alert('Completion verification observability failed');
        }
        return next;
    }
    #settle(previous, update) {
        return this.#persist({ ...previous, ...update, updatedAt: Date.now(), generation: previous.generation + 1 }, previous);
    }
    #blocked(previous, reason) {
        const record = this.#settle(previous, { state: 'BLOCKED', reason });
        return { action: 'blocked', reason, record };
    }
    async #revisionMatches(record, deadline, signal) {
        if (signal?.aborted || Date.now() >= deadline)
            return false;
        try {
            const revision = await bounded(() => this.operations.currentRevision(), Math.max(1, Math.min(10_000, deadline - Date.now())), signal);
            return revision === record.revision && !signal?.aborted && Date.now() < deadline;
        }
        catch {
            return false;
        }
    }
    async #run(proposal, signal) {
        const contract = createHash('sha256')
            .update(JSON.stringify([proposal.goal, proposal.criteria, proposal.environment]))
            .digest('hex');
        const prior = this.store.read(proposal.taskId);
        if (prior &&
            (prior.contract !== contract ||
                prior.state === 'COMPLETED' ||
                prior.state === 'BLOCKED' ||
                prior.state === 'ESCALATED')) {
            if (prior.state === 'COMPLETED' &&
                prior.contract === contract &&
                prior.revision === proposal.revision &&
                (await this.#revisionMatches(prior, Date.now() + 10_000, signal))) {
                return { action: 'complete', record: prior };
            }
            return {
                action: 'blocked',
                reason: 'Task contract changed or task is terminal; explicit administrative recovery required',
                record: prior,
            };
        }
        if (prior?.state === 'VERIFICATION_PENDING') {
            // Never redispatch an uncertain in-flight operation after restart. The lease remains authoritative.
            if (prior.operationDeadline <= Date.now() || prior.owner !== this.#owner) {
                return this.#blocked(prior, 'Unsettled verification after restart or lease expiration');
            }
            return { action: 'blocked', reason: 'Another completion attempt is pending', record: prior };
        }
        if (prior) {
            if (prior.revision === proposal.revision)
                return this.#blocked(prior, 'Repair made no repository progress');
            if (prior.deadline <= Date.now() || prior.gates >= prior.budgets.maxGateAttempts) {
                return this.#blocked(prior, 'Task deadline or gate budget exhausted');
            }
        }
        const now = Date.now();
        let record = this.#persist({
            taskId: proposal.taskId,
            contract,
            revision: proposal.revision,
            state: 'VERIFICATION_PENDING',
            generation: prior ? prior.generation + 1 : 0,
            owner: this.#owner,
            attemptId: randomUUID(),
            epoch: prior?.epoch ?? randomUUID(),
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
            deadline: prior?.deadline ?? now + this.#budgets.taskTimeoutMs,
            operationDeadline: Math.min(prior?.deadline ?? Infinity, now + (prior?.budgets.gateTimeoutMs ?? this.#budgets.gateTimeoutMs)),
            repairs: prior?.repairs ?? 0,
            gates: (prior?.gates ?? 0) + 1,
            verifications: prior?.verifications ?? 0,
            budgets: prior?.budgets ?? this.#budgets,
            ...(prior?.report ? { report: prior.report } : {}),
            reason: 'Completion proposed; gate dispatch reserved',
        }, prior);
        const gateStarted = performance.now();
        let decision;
        try {
            decision = decisionSchema.parse(await bounded((operationSignal) => this.operations.gate(proposal, operationSignal), Math.max(1, record.operationDeadline - Date.now()), signal));
        }
        catch {
            decision = {
                action: 'independent_verify',
                policyVersion: POLICY_VERSION,
                reason: 'Gate failure; deterministic fallback',
            };
        }
        if (signal?.aborted)
            return this.#blocked(record, 'Verification cancelled');
        decision = { ...decision, recommendedAction: decision.action };
        if (mandatoryVerification(proposal))
            decision = {
                ...decision,
                action: 'independent_verify',
                reason: 'Mandatory verification policy override',
            };
        if (decision.action === 'quick_check' && !proposal.quickCheck)
            decision = {
                ...decision,
                action: 'independent_verify',
                reason: 'No applicable host-owned deterministic checker',
            };
        // Deterministic 5% skip audit; selected tasks are verified before completion.
        if (decision.action === 'skip' &&
            parseInt(createHash('sha256').update(proposal.taskId).digest('hex').slice(0, 8), 16) % 20 === 0) {
            decision = { ...decision, action: 'independent_verify', auditedSkip: true, reason: 'Sampled skip audit' };
        }
        if (Date.now() >= record.deadline)
            return this.#blocked(record, 'Task deadline exhausted');
        record = this.#settle(record, {
            decision,
            gateLatencyMs: performance.now() - gateStarted,
            reason: decision.reason,
        });
        if (decision.action === 'skip') {
            record = this.#settle(record, { operationDeadline: Math.min(record.deadline, Date.now() + 10_000) });
            if (!(await this.#revisionMatches(record, record.operationDeadline, signal))) {
                return this.#blocked(record, 'Task changed or cancelled before completion');
            }
            record = this.#settle(record, {
                state: 'COMPLETED',
                reason: 'Policy-authorized completion without additional verification',
            });
            return { action: 'complete', record };
        }
        if (record.verifications >= record.budgets.maxVerifications)
            return this.#blocked(record, 'Verification budget exhausted');
        record = this.#settle(record, {
            attemptId: randomUUID(),
            verifications: record.verifications + 1,
            operationDeadline: Math.min(record.deadline, Date.now() + record.budgets.operationTimeoutMs),
            reason: 'Verification dispatch reserved',
        });
        // Deliberately exclude worker evidence, history, and subjective confidence.
        const request = {
            goal: proposal.goal,
            criteria: proposal.criteria,
            environment: proposal.environment,
            revision: proposal.revision,
            attemptId: record.attemptId,
        };
        const verificationStarted = performance.now();
        let report;
        try {
            report = reportSchema.parse(await bounded((operationSignal) => decision.action === 'quick_check'
                ? this.operations.quickCheck(proposal, request, operationSignal)
                : this.operations.verify(request, operationSignal), Math.max(1, record.operationDeadline - Date.now()), signal));
        }
        catch {
            record = this.#settle(record, { verificationLatencyMs: performance.now() - verificationStarted });
            return this.#blocked(record, 'Verifier timeout, error, cancellation, or malformed result');
        }
        if (report.attemptId !== record.attemptId ||
            report.revision !== proposal.revision ||
            signal?.aborted ||
            Date.now() >= record.operationDeadline ||
            !(await this.#revisionMatches(record, Math.min(record.deadline, record.operationDeadline), signal))) {
            return this.#blocked(record, 'Stale, late, conflicting, or cancelled verification result');
        }
        const previousReport = record.report;
        record = this.#settle(record, {
            report,
            verificationLatencyMs: performance.now() - verificationStarted,
            reason: `Verification outcome: ${report.outcome}`,
        });
        if (report.outcome === 'PASS') {
            if (signal?.aborted || Date.now() >= Math.min(record.deadline, record.operationDeadline)) {
                return this.#blocked(record, 'Deadline or cancellation reached before completion');
            }
            record = this.#settle(record, { state: 'COMPLETED', reason: `Completed through ${decision.action}` });
            return { action: 'complete', record };
        }
        if (report.outcome !== 'FAIL')
            return this.#blocked(record, `Verification ${report.outcome}; completion not established`);
        if (record.repairs >= record.budgets.maxRepairs ||
            record.verifications >= record.budgets.maxVerifications ||
            Date.now() >= record.deadline ||
            previousReport?.evidence === report.evidence) {
            return this.#blocked(record, 'Repair budget, deadline, or repeated-failure limit reached');
        }
        // Consume the repair before returning its dispatch instruction. A crash never refunds it.
        record = this.#settle(record, { state: 'REPAIR_REQUIRED', repairs: record.repairs + 1, reason: 'Repair reserved' });
        return { action: 'repair', record };
    }
}
//# sourceMappingURL=orchestrator.js.map