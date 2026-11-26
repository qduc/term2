import { Term2ProtocolError } from './types';

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
