import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

declare const inputSurgeApprovalBrand: unique symbol;

/**
 * One-use authority to admit a previously confirmed input-surge request.
 *
 * The brand is intentionally opaque. Runtime provenance and the content
 * binding live in the module-private WeakMap, so a structurally similar value
 * supplied by a caller has no authority.
 */
export type InputSurgeApproval = {
  readonly [inputSurgeApprovalBrand]: never;
};

const approvals = new WeakMap<object, string>();

function contentFingerprint(input: string | UserTurn): string {
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
export function issueInputSurgeApproval(input: string | UserTurn): InputSurgeApproval {
  const approval = Object.freeze({}) as InputSurgeApproval;
  approvals.set(approval, contentFingerprint(input));
  return approval;
}

/**
 * Validate and consume an approval at the provider-request admission boundary.
 * An issued approval is single-use even when the presented content differs.
 */
export function consumeInputSurgeApproval(approval: unknown, input: string | UserTurn): boolean {
  if (!approval || typeof approval !== 'object') return false;
  const expectedFingerprint = approvals.get(approval);
  if (!expectedFingerprint) return false;
  approvals.delete(approval);
  return expectedFingerprint === contentFingerprint(input);
}
