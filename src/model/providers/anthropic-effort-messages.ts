/**
 * Per-message effort on the Anthropic Messages API (beta
 * `mid-conversation-output-config-2026-07-01`): an effort-only message
 * `{"role":"system","content":[],"output_config":{"effort":...}}` changes effort
 * for later turns while the top-level `output_config.effort` stays put, so the
 * cached prefix survives (measured on Claude Haiku 5.5, 2026-11-14).
 *
 * The AI SDK cannot express that message, so `ai-sdk-streamed-model.ts` puts a
 * sentinel text part at the start of the user message the change governs and
 * this fetch wrapper replaces it with the effort message placed just before
 * that user message, adding the beta header. A body without the sentinel is
 * forwarded untouched, byte for byte.
 */

export const ANTHROPIC_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';

const SENTINEL_PREFIX = 'term2-effort-update:9c4e1f7a:';
const SENTINEL = /^term2-effort-update:9c4e1f7a:([a-z]+)$/;

export function effortSentinel(effort: string): string {
  return `${SENTINEL_PREFIX}${effort}`;
}

export function withAnthropicEffortMessages(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes(SENTINEL_PREFIX)) return base(input, init);
    const parsed = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) throw new Error('Per-message effort marker outside Anthropic messages');
    parsed.messages = parsed.messages.flatMap((message: any) => {
      const first = Array.isArray(message?.content) ? message.content[0] : undefined;
      const match = message?.role === 'user' && first?.type === 'text' ? SENTINEL.exec(first.text) : null;
      if (!match || message.content.length < 2) return [message];
      return [
        { role: 'system', content: [], output_config: { effort: match[1] } },
        { ...message, content: message.content.slice(1) },
      ];
    });
    const rewritten = JSON.stringify(parsed);
    // A sentinel the rewrite did not place must never reach the model as text.
    if (rewritten.includes(SENTINEL_PREFIX)) throw new Error('Per-message effort marker could not be placed');
    const headers = new Headers(init?.headers);
    const betas = (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter(Boolean);
    if (!betas.includes(ANTHROPIC_EFFORT_BETA))
      headers.set('anthropic-beta', [...betas, ANTHROPIC_EFFORT_BETA].join(','));
    return base(input, { ...init, body: rewritten, headers });
  }) as typeof fetch;
}
