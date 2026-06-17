import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { formatUserTurnForDisplay, hasUserTurnContent, normalizeUserTurn } from './user-turn.js';

it('formatUserTurnForDisplay() summarizes attachments without image bytes', () => {
  const text = formatUserTurnForDisplay({
    text: 'Analyze this',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  expect(text).toBe('Analyze this\n[1 image attached]');
  expect(text.includes('abc123')).toBe(false);
});

it('normalizeUserTurn() removes pasted image sentinels from submitted text', () => {
  const turn = normalizeUserTurn({
    text: '\uE000f9uatvt88vql1:1\uE001 Tell me what you see',
    images: [{ id: 'f9uatvt88vql1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  expect(turn.text).toBe('Tell me what you see');
});

it('formatUserTurnForDisplay() does not render pasted image sentinel IDs', () => {
  const text = formatUserTurnForDisplay(
    normalizeUserTurn({
      text: '\uE000f9uatvt88vql1:1\uE001 Tell me what you see',
      images: [{ id: 'f9uatvt88vql1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
    }),
  );

  expect(text).toBe('Tell me what you see\n[1 image attached]');
  expect(text.includes('f9uatvt88vql1')).toBe(false);
});

it('hasUserTurnContent() accepts image-only turns', () => {
  expect(
    hasUserTurnContent({
      text: '',
      images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
    }),
  ).toBe(true);
});
