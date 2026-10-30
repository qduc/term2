import { normalizeUserTurn } from '../types/user-turn.js';
const approvals = new WeakMap();
function contentFingerprint(input) {
    const turn = normalizeUserTurn(input);
    return JSON.stringify({
        text: turn.text,
        images: (turn.images ?? []).map((image) => ({
            id: image.id,
            data: image.data,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            displayNumber: image.displayNumber,
        })),
        skill: turn.skill
            ? {
                name: turn.skill.name,
                description: turn.skill.description,
                body: turn.skill.body,
            }
            : null,
    });
}
/** Issue one approval for exactly the normalized turn that was confirmed. */
export function issueInputSurgeApproval(input) {
    const approval = Object.freeze({});
    approvals.set(approval, contentFingerprint(input));
    return approval;
}
/**
 * Validate and consume an approval at the provider-request admission boundary.
 * An issued approval is single-use even when the presented content differs.
 */
export function consumeInputSurgeApproval(approval, input) {
    if (!approval || typeof approval !== 'object')
        return false;
    const expectedFingerprint = approvals.get(approval);
    if (!expectedFingerprint)
        return false;
    approvals.delete(approval);
    return expectedFingerprint === contentFingerprint(input);
}
//# sourceMappingURL=input-surge-approval.js.map