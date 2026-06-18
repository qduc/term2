// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import SkillSelectionMenu from './SkillSelectionMenu.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';

const MOCK_SKILLS: SkillInfo[] = [
  {
    name: 'skill-one',
    description: 'First test skill description',
    location: '/path/to/one',
    isProjectLevel: false,
    body: 'body',
    rawContent: 'raw',
  },
  {
    name: 'skill-two',
    description: 'Second test skill description',
    location: '/path/to/two',
    isProjectLevel: true,
    body: 'body2',
    rawContent: 'raw2',
  },
];

it('SkillSelectionMenu renders both columns and details of the selected skill', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={MOCK_SKILLS} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  // Left column displays the skill names
  expect(frame?.includes('skill-one')).toBe(true);
  expect(frame?.includes('skill-two')).toBe(true);

  // Right column displays the selected skill's details
  expect(frame?.includes('First test skill description')).toBe(true);
  // Second skill is not selected, so its description is not shown
  expect(frame?.includes('Second test skill description')).toBe(false);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu displays project level scope if applicable', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={MOCK_SKILLS} selectedIndex={1} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  expect(frame?.includes('Second test skill description')).toBe(true);
  expect(frame?.includes('Scope: Project level')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu displays fallback text when there are no skills', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={[]} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  let frame = lastFrame();
  expect(frame?.includes('No skills available')).toBe(true);

  await act(async () => {
    unmount();
  });

  // With query
  await act(async () => {
    const result = render(<SkillSelectionMenu items={[]} selectedIndex={0} query="nonexistent" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  frame = lastFrame();
  expect(frame?.includes('No matching skills')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu truncates extremely long skill names in the left column', async () => {
  const extremelyLongSkill: SkillInfo = {
    name: 'extremely-long-skill-name-that-definitely-exceeds-thirty-characters',
    description: 'Extremely long description',
    location: '/path/to/long',
    isProjectLevel: false,
    body: 'body',
    rawContent: 'raw',
  };

  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={[extremelyLongSkill]} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  // The full name should be truncated
  expect(frame?.includes('extremely-long-skill-name-that-definitely-exceeds-thirty-characters')).toBe(false);
  expect(frame?.includes('extremely-long-skill-name')).toBe(true);

  await act(async () => {
    unmount();
  });
});
