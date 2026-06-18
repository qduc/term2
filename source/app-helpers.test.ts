import { describe, expect, it } from 'vitest';
import { estimateLastTurnTokens } from './app-helpers.js';

describe('estimateLastTurnTokens', () => {
  it('estimates text input from serialized bytes', () => {
    expect(estimateLastTurnTokens({ text: '12345678' })).toBe(3);
  });

  it('includes image payloads when estimating multimodal turns', () => {
    expect(
      estimateLastTurnTokens({
        text: 'look',
        images: [{ id: 'image-1', data: 'abcd', mimeType: 'image/png', byteSize: 4, displayNumber: 1 }],
      }),
    ).toBeGreaterThan(estimateLastTurnTokens({ text: 'look' }));
  });
});
