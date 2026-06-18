import { it, expect } from 'vitest';
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

it('formatUserTurnForDisplay() shows skill placeholder when skill is attached', () => {
  const text = formatUserTurnForDisplay({
    text: 'Refactor this module',
    skill: {
      name: 'god-object-refactor',
      description: 'Break up god objects',
      body: '# Skill Content\nDetailed instructions...',
    },
  });

  expect(text).toContain('[Skill: god-object-refactor]');
  expect(text).toContain('Refactor this module');
  expect(text.includes('Detailed instructions')).toBe(false);
});

it('formatUserTurnForDisplay() shows only skill placeholder when no text is provided', () => {
  const text = formatUserTurnForDisplay({
    text: '',
    skill: {
      name: 'god-object-refactor',
      description: 'Break up god objects',
      body: '# Skill Content\nDetailed instructions...',
    },
  });

  expect(text).toBe('[Skill: god-object-refactor]');
  expect(text.includes('Detailed instructions')).toBe(false);
});

it('formatUserTurnForDisplay() shows skill and images when both are present', () => {
  const text = formatUserTurnForDisplay({
    text: 'Analyze this',
    skill: {
      name: 'codebase-design',
      description: 'Design patterns',
      body: '# Design patterns',
    },
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  expect(text).toContain('[Skill: codebase-design]');
  expect(text).toContain('Analyze this');
  expect(text).toContain('[1 image attached]');
  expect(text.includes('Design patterns')).toBe(false);
  expect(text.includes('abc123')).toBe(false);
});

it('normalizeUserTurn() preserves skill attachment', () => {
  const skill = {
    name: 'test-skill',
    description: 'Test skill',
    body: '# Test',
  };
  const turn = normalizeUserTurn({
    text: 'Test message',
    skill,
  });

  expect(turn.skill).toEqual(skill);
  expect(turn.text).toBe('Test message');
});
