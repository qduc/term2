// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { Text } from 'ink';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { describe, expect, it } from 'vitest';
import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';
import { findConformanceProblems } from './conformance.js';
import { SCENES, renderScene, type Scene } from './scenes.js';

/**
 * The conformance suite is only worth trusting if it can fail. These are skins
 * that are deliberately broken in the three ways the suite exists to catch.
 */

const scene = (id: string) => SCENES.find((candidate) => candidate.id === id)!;

const DropsChildren: Skin['ApprovalFrame'] = ({ header }) => <Text>{header}</Text>;

describe('findConformanceProblems', () => {
  it('passes a conforming render', () => {
    const user = scene('user-message');
    expect(
      findConformanceProblems(renderScene(user, { skin: 'classic', theme: 'dark', columns: 60 }), user, 60),
    ).toEqual([]);
  });

  it('flags a line wider than the terminal', () => {
    const user = scene('user-message');
    // Render with a wide terminal, then judge the frame against a narrower one.
    const wide = renderScene(user, { skin: 'classic', theme: 'dark', columns: 120 });
    const problems = findConformanceProblems(wide.replace('why do', 'why '.repeat(30)), user, 60);
    expect(problems.some((problem) => problem.includes('over the 60 available'))).toBe(true);
  });

  it('flags content a skin drops from what the container handed it', () => {
    const approval = scene('approval-shell');
    const broken: Skin = { ...classicSkin, ApprovalFrame: DropsChildren };
    const frame = renderScene(approval, { skin: broken, theme: 'dark', columns: 80 });
    const problems = findConformanceProblems(frame, approval, 80);
    expect(problems).toContain('approval-shell no longer shows "git push --force-with-lease"');
    expect(problems).toContain('approval-shell no longer shows "Allow once"');
  });

  it('flags a skin that renders nothing', () => {
    const user = scene('user-message');
    const broken: Skin = { ...classicSkin, UserMessage: () => null };
    const frame = renderScene(user, { skin: broken, theme: 'dark', columns: 80 });
    expect(findConformanceProblems(frame, user, 80)).toEqual(['rendered nothing']);
  });

  it('only checks content from the width a scene asks for', () => {
    const status = scene('status');
    expect(status.contentFromColumns).toBe(60);
    expect(findConformanceProblems('x', { ...status, mustContain: ['absent'] }, 40)).toEqual([]);
    expect(findConformanceProblems('x', { ...status, mustContain: ['absent'] }, 60)).toEqual([
      'status no longer shows "absent"',
    ]);
  });

  it('is not fooled by a wrapped phrase interrupted by borders', () => {
    const approval = scene('approval-shell');
    const frame = '│ git push --force-with-lease origin\n│ feature/auth-refresh && pnpm publish';
    const problems = findConformanceProblems(frame, { ...approval, mustContain: ['origin feature/auth-refresh'] }, 80);
    expect(problems).toEqual([]);
  });
});

describe('renderScene', () => {
  const WidthProbe = () => <Text>{`columns=${useTerminalColumns()}`}</Text>;
  const probe: Scene = {
    id: 'probe',
    description: 'prints the width hooks see',
    node: () => <WidthProbe />,
    mustContain: [],
  };

  it.each([40, 60, 100, 120])('shows hooks the real terminal width, %i columns', (columns) => {
    // Regression: renderToString has no stdout width, so every width-adaptive skin silently
    // fell back to 80 and the suite never exercised its narrow layouts.
    expect(renderScene(probe, { skin: 'classic', theme: 'dark', columns })).toContain(`columns=${columns}`);
  });

  it('restores process.stdout.columns afterwards', () => {
    const before = process.stdout.columns;
    renderScene(probe, { skin: 'classic', theme: 'dark', columns: 53 });
    expect(process.stdout.columns).toBe(before);
  });

  it('restores it even when the render throws', () => {
    const before = process.stdout.columns;
    const broken: Scene = {
      ...probe,
      node: () => {
        throw new Error('boom');
      },
    };
    expect(() => renderScene(broken, { skin: 'classic', theme: 'dark', columns: 53 })).toThrow('boom');
    expect(process.stdout.columns).toBe(before);
  });
});
