/**
 * Result of reviewing a pending approval; absence of review never grants permission.
 * `refused` marks a request unattended approval closed by policy in the same batch as its open:
 * like an approved one, it never waited for a person and is never published as open.
 */
export type ApprovalReviewResult = ApprovalReviewOutcome & {
  readonly refused?: true;
  /** Human-prompt visibility; absent on historical records. Raw evidence remains recorded. */
  readonly showReview?: boolean;
};

type ApprovalReviewOutcome =
  | { readonly kind: 'not_reviewed'; readonly approved: false }
  | { readonly kind: 'unavailable'; readonly approved: false }
  | { readonly kind: 'bypassed'; readonly approved: true; readonly grant?: string }
  | {
      readonly kind: 'reviewed';
      readonly approved: boolean;
      /** The grant an approved review answers with; absent means a plain allow. */
      readonly grant?: string;
      /** Advisory assessment only: the verdict informs the person and never answers the request. */
      readonly advisoryOnly?: true;
      readonly advisory: {
        readonly approved: boolean;
        readonly reasoning: string;
        readonly model: string;
        readonly source?: 'llm' | 'system';
        readonly riskLevel?: 'low' | 'medium' | 'high';
        readonly authorization?: 'explicit' | 'implied' | 'weak' | 'unknown';
        readonly confidence?: 'high' | 'low';
      };
    };

/** Keep model-supplied display text bounded and free of terminal control characters and common secrets. */
export function sanitizeApprovalReviewText(text: string): string {
  return text
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(0, 1024);
}

/** Bounded, terminal-safe text for a human-facing review explanation. */
export function formatApprovalReview(result: ApprovalReviewResult): string {
  if (result.kind === 'not_reviewed') return 'Not reviewed automatically.';
  if (result.kind === 'unavailable') return 'Approval review unavailable.';
  if (result.kind === 'bypassed') return 'Approval bypassed by always mode.';
  const advisory = result.advisory;
  const reasoning = sanitizeApprovalReviewText(advisory.reasoning);
  const details = [
    advisory.riskLevel && `risk: ${advisory.riskLevel}`,
    advisory.authorization && `authorization: ${advisory.authorization}`,
    advisory.confidence && `confidence: ${advisory.confidence}`,
  ]
    .filter(Boolean)
    .join(', ');
  return `${advisory.source === 'system' ? 'Safety check' : 'AI review'}${
    details ? ` (${details})` : ''
  }: ${reasoning}`;
}
