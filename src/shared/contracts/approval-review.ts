/** Result of reviewing a pending approval; absence of review never grants permission. */
export type ApprovalReviewResult =
  | { readonly kind: 'not_reviewed'; readonly approved: false }
  | { readonly kind: 'unavailable'; readonly approved: false }
  | {
      readonly kind: 'reviewed';
      readonly approved: boolean;
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
