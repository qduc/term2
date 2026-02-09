export function coerceToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => coerceToText(entry))
      .filter(Boolean)
      .join('');
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidates = ['text', 'value', 'content', 'delta'];
    for (const field of candidates) {
      if (field in record) {
        const text = coerceToText(record[field]);
        if (text) {
          return text;
        }
      }
    }
  }

  return '';
}

export function extractTextDelta(payload: any): string | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  if (typeof payload === 'string') {
    return payload || null;
  }

  if (typeof payload !== 'object') {
    return null;
  }

  const type = typeof (payload as any).type === 'string' ? payload.type : '';
  const looksLikeOutput = typeof type === 'string' && type.includes('output_text');
  const hasOutputProperties = Boolean(
    (payload as any).delta ?? (payload as any).output_text ?? (payload as any).text ?? (payload as any).content,
  );

  if (!looksLikeOutput && !hasOutputProperties) {
    return null;
  }

  const deltaCandidate =
    (payload as any).delta ?? (payload as any).output_text ?? (payload as any).text ?? (payload as any).content;
  const text = coerceToText(deltaCandidate);
  return text || null;
}

export function extractReasoningDelta(event: any): string {
  // OpenAI style
  const data = event?.data;
  if (data && typeof data === 'object' && (data as any).type === 'model') {
    const eventDetail = (data as any).event;
    if (
      eventDetail &&
      typeof eventDetail === 'object' &&
      eventDetail.type === 'response.reasoning_summary_text.delta'
    ) {
      return eventDetail.delta ?? '';
    }
  }

  // OpenRouter style
  const choices = event?.data?.event?.choices;
  if (!choices) return '';
  if (Array.isArray(choices)) {
    return choices[0]?.delta?.reasoning ?? choices[0]?.delta?.reasoning_content ?? '';
  }
  if (typeof choices === 'object') {
    const byZero = (choices as Record<string, any>)['0'];
    const first = byZero ?? choices[Object.keys(choices)[0]];
    return first?.delta?.reasoning ?? first?.delta?.reasoning_content ?? '';
  }
  return '';
}
