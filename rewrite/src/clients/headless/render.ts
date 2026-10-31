/**
 * M1 engine-event renderer retained for the current app/run path until the app
 * integration owner switches headless runs to the direct connection.
 */
import type { HeadlessEvent, HeadlessIo } from './types.js';

/**
 * Streams text deltas as they arrive. Only completed turns get a trailing
 * newline; failure diagnostics go to stderr, while cancelled and failed
 * partial output stays unterminated.
 */
export async function renderTurn(
  events: AsyncIterable<HeadlessEvent>,
  io: HeadlessIo,
): Promise<{ readonly kind: string }> {
  for await (const event of events) {
    if (event.type === 'text_delta' && 'delta' in event && typeof event.delta === 'string') {
      io.stdout.write(event.delta);
      continue;
    }
    if (event.type === 'tool_start_requested' && 'toolName' in event && typeof event.toolName === 'string') {
      io.stderr.write(`Tool: ${event.toolName}\n`);
      continue;
    }
    if (
      event.type === 'interaction_required' &&
      'request' in event &&
      event.request &&
      typeof event.request === 'object'
    ) {
      const request = event.request as {
        readonly kind?: unknown;
        readonly toolName?: unknown;
        readonly summary?: unknown;
      };
      const kind = request.kind === 'question' ? 'Question' : 'Approval';
      const toolName = typeof request.toolName === 'string' ? ` (${request.toolName})` : '';
      const summary = typeof request.summary === 'string' ? `: ${request.summary}` : '';
      io.stderr.write(`${kind} required${toolName}${summary}\n`);
      continue;
    }
    if (event.type === 'turn_ended' && 'result' in event) {
      const result = event.result;
      if (result.kind === 'completed') {
        io.stdout.write('\n');
      } else if (result.kind === 'failed') {
        io.stderr.write(`error ${result.error?.message ?? 'Unknown error.'}\n`);
      }
      return result;
    }
  }

  const result = { kind: 'failed', error: { message: 'Turn ended without a terminal event.' } };
  io.stderr.write(`error ${result.error.message}\n`);
  return result;
}
