import test from 'ava';
import { formatUserTurnForDisplay, hasUserTurnContent, normalizeUserTurn } from './user-turn.js';

test('formatUserTurnForDisplay() summarizes attachments without image bytes', (t) => {
  const text = formatUserTurnForDisplay({
    text: 'Analyze this',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  t.is(text, 'Analyze this\n[1 image attached]');
  t.false(text.includes('abc123'));
});

test('normalizeUserTurn() removes pasted image sentinels from submitted text', (t) => {
  const turn = normalizeUserTurn({
    text: '\uE000f9uatvt88vql1:1\uE001 Tell me what you see',
    images: [{ id: 'f9uatvt88vql1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  t.is(turn.text, 'Tell me what you see');
});

test('formatUserTurnForDisplay() does not render pasted image sentinel IDs', (t) => {
  const text = formatUserTurnForDisplay(
    normalizeUserTurn({
      text: '\uE000f9uatvt88vql1:1\uE001 Tell me what you see',
      images: [{ id: 'f9uatvt88vql1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
    }),
  );

  t.is(text, 'Tell me what you see\n[1 image attached]');
  t.false(text.includes('f9uatvt88vql1'));
});

test('hasUserTurnContent() accepts image-only turns', (t) => {
  t.true(
    hasUserTurnContent({
      text: '',
      images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
    }),
  );
});
