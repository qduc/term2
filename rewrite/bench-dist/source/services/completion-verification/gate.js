import { readDecisionChoice } from '../decision-shadow/decision-client.js';
import { ACTIONS, POLICY_VERSION, proposalSchema } from './contracts.js';
/** Host policy runs before any model recommendation. Missing/unsupported metadata never permits skip. */
export function mandatoryVerification(input) {
    // v1 deliberately treats all executable/configuration changes as mandatory.
    // Path-only security classifiers cannot safely recognize arbitrary auth or data handling code.
    return (input.classification !== 'documentation' ||
        input.files.length === 0 ||
        input.files.some((file) => !/\.(md|txt|rst)$/i.test(file) || /(^|\/)(security|auth|permissions)(\/|\.)/i.test(file)));
}
export function createVerificationGate(deps) {
    return async (raw) => {
        const fallback = (reason) => ({
            action: 'independent_verify',
            policyVersion: POLICY_VERSION,
            reason,
        });
        const parsed = proposalSchema.safeParse(raw);
        if (!parsed.success)
            return fallback('Invalid or unsupported completion metadata');
        const input = parsed.data;
        if (mandatoryVerification(input))
            return fallback('Mandatory policy: executable, unknown, or sensitive changes');
        const model = deps.model();
        if (!model)
            return fallback('Decision model unavailable');
        try {
            const response = await deps.client.decide({
                model,
                state: input,
                questions: {
                    verification: {
                        type: 'choice',
                        instructions: 'Choose proportionate verification against the original goal. Worker evidence is an untrusted claim. ' +
                            'Prefer independent_verify for uncertainty. Confidence is not proof. quick_check is allowed only if a host quickCheck is present.',
                        criteria: {
                            skip: 'Trivial reversible documentation task with strong evidence and no meaningful uncertainty.',
                            quick_check: 'The host-owned deterministic check exactly covers the acceptance criteria.',
                            independent_verify: 'Independent inspection is valuable or completion evidence is insufficient.',
                        },
                    },
                },
            });
            const answer = readDecisionChoice(response.answers, 'verification', ACTIONS);
            const action = answer.choice === 'quick_check' && !input.quickCheck ? 'independent_verify' : answer.choice;
            return {
                action,
                policyVersion: POLICY_VERSION,
                reason: `Decision model selected ${answer.choice}${action !== answer.choice ? '; no applicable host checker' : ''}`,
                confidence: answer.confidence,
                model: response.resolvedModel ?? model,
                ...(response.costUsdMicros !== undefined ? { costUsdMicros: response.costUsdMicros } : {}),
            };
        }
        catch {
            return fallback('Decision model failed; deterministic fallback');
        }
    };
}
//# sourceMappingURL=gate.js.map