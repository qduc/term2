/**
 * Server-Sent Events (SSE) parsing utilities for streaming responses
 */

export interface SSEEvent {
  type: 'data' | 'done';
  data?: any;
}

export class SSEParser {
  private buffer = '';

  parse(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);

      if (!line) continue;

      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          events.push({ type: 'done' });
        } else {
          try {
            const json = JSON.parse(data);
            events.push({ type: 'data', data: json });
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    }

    return events;
  }

  reset() {
    this.buffer = '';
  }
}

export class APIError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
    this.name = 'APIError';
  }
}

export class StreamingNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamingNotSupportedError';
  }
}
