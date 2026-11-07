import { parseEventEnvelope, Term2ProtocolError, type AgentEventEnvelope } from './types';

export interface SseFrame {
  id: number | null;
  event: string | null;
  data: string;
}

function parseFrame(lines: string[]): SseFrame | null {
  if (lines.length === 0) return null;
  let id: number | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'id') {
      if (id !== null || !/^\d+$/u.test(value)) throw new Term2ProtocolError('Malformed SSE sequence');
      id = Number(value);
      if (!Number.isSafeInteger(id) || id < 1) throw new Term2ProtocolError('Malformed SSE sequence');
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}

export function decodeSseText(input: string, carry = ''): { frames: SseFrame[]; carry: string } {
  const text = carry + input.replace(/\r\n?/gu, '\n');
  const parts = text.split('\n\n');
  const nextCarry = parts.pop() ?? '';
  const frames = parts.map((part) => parseFrame(part.split('\n'))).filter((frame): frame is SseFrame => frame !== null);
  return { frames, carry: nextCarry };
}

/** Framing is tied to the accepted boundary, never to individual changes. */
function envelopeFromFrame(frame: SseFrame, sessionId: string): AgentEventEnvelope {
  let value: unknown;
  try { value = JSON.parse(frame.data); }
  catch { throw new Term2ProtocolError('Malformed SSE JSON'); }
  const envelope = parseEventEnvelope(value, sessionId);
  if (frame.event !== envelope.kind)
    throw new Term2ProtocolError('SSE event kind mismatch');
  if (envelope.kind === 'accepted' ? frame.id !== envelope.seq : frame.id !== null)
    throw new Term2ProtocolError('SSE checkpoint does not match envelope');
  return envelope;
}

export async function consumeSseResponse(
  response: Response,
  options: {
    signal?: AbortSignal;
    onFrame: (frame: AgentEventEnvelope) => void;
    expectedSessionId: string;
    onHeartbeat?: () => void;
  },
): Promise<void> {
  if (response.headers.get('x-term2-event-format') !== 'agent-wire-v2') throw new Term2ProtocolError('agent-wire-v2 was not negotiated');
  if (!response.body) throw new Term2ProtocolError('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  try {
    while (true) {
      if (options.signal?.aborted) return;
      const result = await reader.read();
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      if (!text) continue;
      const decoded = decodeSseText(text, carry);
      carry = decoded.carry;
      if (text.includes(':')) options.onHeartbeat?.();
      for (const frame of decoded.frames) {
        options.onFrame(envelopeFromFrame(frame, options.expectedSessionId));
      }
    }
    // An EOF is not an SSE dispatch boundary. A disconnected partial frame
    // must be replayed from the last complete accepted batch, never checkpointed.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

export function createSseResponseFromChunks(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
