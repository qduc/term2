// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CommandMessage from '../../components/message/CommandMessage.js';
import ChatMessage from '../../components/message/ChatMessage.js';
import { THEMES, type ThemeName } from '../../theme/palettes.js';
import { ThemeProvider } from '../../theme/ThemeContext.js';
import { SkinProvider } from '../SkinContext.js';
import { SCENES, renderScene, type Scene } from '../testing/scenes.js';
import { BRAILLE_SPINNER } from '../shared/spinner.js';
import { cardsSkin } from './index.js';

const scene = (id: string): Scene => SCENES.find((candidate) => candidate.id === id)!;

/** A one-off scene around any element, rendered through the same path as the shared scenes. */
const adHoc = (node: () => React.ReactElement): Scene => ({ id: 'ad-hoc', description: '', node, mustContain: [] });

const raw = (target: Scene, theme: ThemeName, columns: number): string =>
  renderScene(target, { skin: 'cards', theme, columns });
const plain = (target: Scene, theme: ThemeName, columns: number): string =>
  stripVTControlCharacters(raw(target, theme, columns));
const lines = (text: string): string[] => text.split('\n');

/** The escape that sets a foreground colour, as chalk writes it at truecolor. */
const fg = (hex: string): string => {
  const value = hex.replace('#', '');
  const channel = (start: number) => parseInt(value.slice(start, start + 2), 16);
  return `\u001B[38;2;${channel(0)};${channel(2)};${channel(4)}m`;
};

const SHELL = {
  sender: 'command',
  command: 'rg -n "expiresAt" src',
  output: 'src/auth.ts:42:  if (token.expiresAt < Date.now())',
  toolName: 'shell',
  toolArgs: { command: 'rg -n "expiresAt" src' },
} as const;

const standardCall = (overrides: Record<string, unknown>) =>
  adHoc(() => <CommandMessage {...(SHELL as object as { command: string })} {...overrides} displayMode="standard" />);
const conciseCall = (overrides: Record<string, unknown>) =>
  adHoc(() => <CommandMessage {...(SHELL as object as { command: string })} {...overrides} displayMode="concise" />);

const COMPLETED = { status: 'completed', success: true };
const FAILED = { status: 'failed', success: false };

let originalLevel: typeof chalk.level;
beforeAll(() => {
  // renderToString only carries colour when chalk is told the terminal supports it.
  originalLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = originalLevel;
});

describe('cards: tool calls', () => {
  it('draws a standard call as a rounded card whose border is the status colour', () => {
    const ok = raw(standardCall(COMPLETED), 'dark', 80);
    const failed = raw(standardCall(FAILED), 'dark', 80);

    expect(lines(ok)[0]).toContain(fg(THEMES.dark.toolStatus.completed!));
    expect(lines(ok)[0]).not.toContain(fg(THEMES.dark.toolStatus.failed!));
    expect(lines(failed)[0]).toContain(fg(THEMES.dark.toolStatus.failed!));
    expect(lines(ok)[0]).toContain('╭');
  });

  it('gives a failed call a heavier border, so failure shows without colour', () => {
    const ok = lines(plain(standardCall(COMPLETED), 'mono', 80));
    const failed = lines(plain(standardCall(FAILED), 'mono', 80));

    expect(ok[0].startsWith('╭')).toBe(true);
    expect(failed[0].startsWith('┏')).toBe(true);
    expect(failed.at(-1)!.startsWith('┗')).toBe(true);
  });

  it('puts the header on the first row of the card and the output inside it', () => {
    const [top, header, output, bottom] = lines(plain(standardCall(COMPLETED), 'mono', 80));
    expect(top.startsWith('╭')).toBe(true);
    expect(header).toContain('✓');
    expect(header).toContain('rg -n "expiresAt" src');
    expect(output).toContain('src/auth.ts:42');
    expect(bottom.startsWith('╰')).toBe(true);
  });

  it('keeps every card edge in one straight column at every width', () => {
    for (const columns of [40, 60, 80, 120]) {
      for (const target of [standardCall(COMPLETED), standardCall(FAILED)]) {
        const frame = lines(plain(target, 'mono', columns));
        expect(new Set(frame.map((line) => Array.from(line).length))).toEqual(new Set([columns]));
      }
    }
  });

  it('does not card concise calls: one bare line each, glyph then action', () => {
    const frame = plain(scene('tools-concise'), 'mono', 80);
    expect(frame).not.toMatch(/[╭╮╰╯┏┓┗┛│┃]/);
    const rg = lines(frame).find((line) => line.includes('rg -n'))!;
    expect(rg.startsWith('✓ rg -n "expiresAt" src')).toBe(true);
    expect(
      lines(frame)
        .find((line) => line.includes('pnpm test auth'))!
        .startsWith('✗'),
    ).toBe(true);
  });

  it('still carries the status in a glyph with no colour at all', () => {
    const standard = plain(scene('tools-standard'), 'mono', 80);
    const concise = plain(scene('tools-concise'), 'mono', 80);
    for (const frame of [standard, concise]) {
      expect(frame).toContain('✓');
      expect(frame).toContain('✗');
    }
  });

  it('labels a non-shell tool with its own name in the header', () => {
    const target = standardCall({
      ...COMPLETED,
      command: '',
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com' },
      output: 'ok',
    });
    expect(lines(plain(target, 'mono', 80))[1]).toContain('web_fetch');
  });
});

describe('cards: running calls animate only while they run', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderHeader = (status: 'running' | 'completed') =>
    render(
      <ThemeProvider theme={THEMES.dark}>
        <SkinProvider skin={cardsSkin}>
          <cardsSkin.ToolHeader status={status} display="concise" toolName="shell" action="pnpm build" />
        </SkinProvider>
      </ThemeProvider>,
    );

  it('advances the spinner of a running call', async () => {
    vi.useFakeTimers();
    const view = renderHeader('running');
    const first = stripVTControlCharacters(view.lastFrame() ?? '');
    expect(BRAILLE_SPINNER).toContain(first[0] as (typeof BRAILLE_SPINNER)[number]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const second = stripVTControlCharacters(view.lastFrame() ?? '');
    expect(second[0]).not.toBe(first[0]);
    expect(second).toContain('pnpm build');
    view.unmount();
  });

  it('schedules no timer for a settled call', () => {
    vi.useFakeTimers();
    const view = renderHeader('completed');
    expect(vi.getTimerCount()).toBe(0);
    expect(stripVTControlCharacters(view.lastFrame() ?? '')).toContain('✓ pnpm build');
    view.unmount();
  });
});

describe('cards: messages', () => {
  it('sets the user turn in an accent card titled "you" with its corners aligned', () => {
    for (const columns of [40, 60, 100]) {
      const frame = lines(plain(scene('user-message'), 'mono', columns));
      expect(frame[0].startsWith('╭─ you ')).toBe(true);
      expect(frame[0].endsWith('╮')).toBe(true);
      expect(frame.at(-1)!.startsWith('╰')).toBe(true);
      expect(new Set(frame.map((line) => Array.from(line).length))).toEqual(new Set([columns]));
    }
    expect(raw(scene('user-message'), 'dark', 80)).toContain(fg(THEMES.dark.accent!));
  });

  it('keeps a long user message whole inside its card', () => {
    const text = 'please look at the retry helper and tell me why it swallows 401 responses on the second attempt';
    const target = adHoc(() => <ChatMessage msg={{ id: 'u', sender: 'user', text }} />);
    const words = plain(target, 'mono', 40)
      .replace(/[│╭╮╰╯─]/g, ' ')
      .replace(/\s+/g, ' ');
    expect(words).toContain(text);
  });

  it('keeps the banner a small card that shrinks to its content', () => {
    const frame = lines(plain(scene('banner'), 'mono', 120));
    const card = frame.filter((line) => /[╭│╰]/.test(line));
    expect(card[0]).toMatch(/^╭─ term² v\S+ ─*╮$/);
    expect(Array.from(card[0]).length).toBeLessThan(60);
    expect(card.some((line) => line.includes('gpt-5.6-luna'))).toBe(true);
  });

  it('leaves answers bare and marks reasoning with a rail', () => {
    const frame = lines(plain(scene('assistant-answer'), 'mono', 80));
    const reasoning = frame.find((line) => line.includes('Checking the refresh path'))!;
    const answer = frame.find((line) => line.includes('Findings'))!;
    expect(reasoning.startsWith('┆ ')).toBe(true);
    expect(answer).not.toMatch(/^[┆│]/);
  });

  it('declares the columns its reasoning rail takes', () => {
    expect(cardsSkin.assistantGutter).toBe(2);
  });
});

describe('cards: approvals', () => {
  it('draws the danger class with a different shape and a triangle, not only a different colour', () => {
    const danger = lines(plain(scene('approval-danger'), 'mono', 80));
    const caution = lines(plain(scene('approval-shell'), 'mono', 80));

    expect(danger[0]).toMatch(/^╔═ ▲ Approval needed ═*╗$/);
    expect(danger.at(-1)).toMatch(/^╚═*╝$/);
    expect(caution[0]).toMatch(/^╭─ Approval needed ─*╮$/);
    expect(caution.at(-1)).toMatch(/^╰─*╯$/);
    expect(caution.join('\n')).not.toContain('▲');
  });

  it('colours the box warning for caution and danger for danger', () => {
    expect(lines(raw(scene('approval-shell'), 'dark', 80))[0]).toContain(fg(THEMES.dark.warning!));
    expect(lines(raw(scene('approval-danger'), 'dark', 80))[0]).toContain(fg(THEMES.dark.danger!));
  });

  it('keeps the header content and the body inside the box', () => {
    const frame = lines(plain(scene('approval-shell'), 'mono', 100));
    const inside = frame.slice(1, -1);
    expect(inside.every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
    expect(inside.join('\n')).toContain('Agent wants to run: shell');
    expect(inside.join('\n')).toContain('git push --force-with-lease');
  });

  it('shows the options as one row of chips, the selected one marked, with its description beneath', () => {
    const frame = lines(plain(scene('approval-shell'), 'mono', 100));
    const chips = frame.find((line) => line.includes('1 Allow once'))!;
    expect(chips).toContain('❯ 1 Allow once');
    expect(chips).toContain('2 Deny');
    expect(chips.split('❯')).toHaveLength(2);
    const next = frame[frame.indexOf(chips) + 1];
    expect(next).toContain('Allow this tool call.');
  });

  it('fills the selected chip with reverse video so it is readable on any palette', () => {
    for (const theme of ['dark', 'light'] as const) {
      const row = lines(raw(scene('approval-shell'), theme, 100)).find((line) => line.includes('Allow once'))!;
      const selected = row.slice(row.indexOf('\u001B[7m'));
      expect(selected).toContain('\u001B[7m');
      expect(stripVTControlCharacters(selected)).toMatch(/^ ❯ 1 Allow once/);
    }
  });

  it('lays the chips out the same way in a live render, where the terminal reports its width', async () => {
    let frame = '';
    await act(async () => {
      const view = render(
        <ThemeProvider theme={THEMES.mono}>
          <SkinProvider skin={cardsSkin}>{scene('approval-shell').node()}</SkinProvider>
        </ThemeProvider>,
      );
      frame = stripVTControlCharacters(view.lastFrame() ?? '');
      view.unmount();
    });
    // ink-testing-library reports a 100-column terminal.
    const chips = frame.split('\n').find((line) => line.includes('1 Allow once'))!;
    expect(chips).toContain('2 Deny');
  });

  it('stacks the options one per line when the terminal is narrow', () => {
    const frame = lines(plain(scene('approval-shell'), 'mono', 40));
    const allow = frame.findIndex((line) => line.includes('1 Allow once'));
    const deny = frame.findIndex((line) => line.includes('2 Deny'));
    expect(allow).toBeGreaterThan(-1);
    expect(deny).toBe(allow + 1);
  });

  it('stacks options whose labels cannot share a row even at 100 columns', () => {
    const frame = lines(plain(scene('approval-danger'), 'mono', 100));
    const rows = ['1 Allow this command', '2 Deny', '3 Allow for this session', '4 Always allow for this project'].map(
      (label) => frame.findIndex((line) => line.includes(label)),
    );
    expect(rows.every((row) => row > -1)).toBe(true);
    expect(new Set(rows).size).toBe(4);
  });

  it('keeps every option label of a list-only approval on screen at 40 columns', () => {
    const text = plain(scene('approval-denied-read'), 'mono', 40)
      .replace(/[│╔╗╚╝═]/g, ' ')
      .replace(/\s+/g, ' ');
    for (const label of ['Allow once', 'Deny', 'Allow and remember this path', 'Run unsandboxed once']) {
      expect(text).toContain(label);
    }
  });
});

describe('cards: live region', () => {
  it('boxes the input in the active border colour with the marker inside', () => {
    const frame = lines(plain(scene('live-idle'), 'mono', 60));
    const box = frame.findIndex((line) => line.startsWith('╭'));
    expect(frame[box + 1]).toMatch(/^│ ❯ .*│$/);
    expect(frame[box + 2].startsWith('╰')).toBe(true);
    const colouredTop = lines(raw(scene('live-idle'), 'dark', 60)).find((line) => line.includes('╭'))!;
    expect(colouredTop).toContain(fg(THEMES.dark.borderActive!));
  });

  it('puts the key hints below the input box, separated by dots', () => {
    const frame = lines(plain(scene('live-idle'), 'mono', 100));
    const bottom = frame.findIndex((line) => line.startsWith('╰'));
    const hints = frame.findIndex((line) => line.includes('/ commands'));
    expect(hints).toBeGreaterThan(bottom);
    expect(frame[hints]).toContain('/ commands · @ paths · ! shell');
  });

  it('shows the working line with a spinner and the elapsed time', () => {
    const frame = lines(plain(scene('live-working'), 'mono', 80));
    const working = frame.find((line) => line.includes('Thinking'))!;
    expect(working).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking · \d+s/);
  });

  it('draws no rule above the live controls', () => {
    const frame = lines(plain(scene('live-idle'), 'mono', 80));
    expect(frame.some((line) => /^─+$/.test(line.trim()))).toBe(false);
  });
});

describe('cards: status bar', () => {
  it('shows pills for safety, model, context gauge, tokens, cache and cost on a wide terminal', () => {
    const frame = plain(scene('status'), 'mono', 100);
    for (const part of ['◆ Sandboxed', 'gpt-5.6-luna', 'ctx ▰', '84%', '↑229.0k', '52% cached', '$0.12']) {
      expect(frame).toContain(part);
    }
  });

  it('sets pills on a quiet surface in colour, and brackets them when there is no colour', () => {
    const coloured = raw(scene('status'), 'dark', 100);
    expect(coloured).toContain('\u001B[48;2;30;41;59m');
    const mono = plain(scene('status'), 'mono', 100);
    expect(mono).toContain('‹ ◆ Sandboxed ›');
  });

  it('colours the context gauge by how full the window is', () => {
    expect(raw(scene('status'), 'dark', 100)).toContain(fg(THEMES.dark.warning!));
  });

  it('keeps the safety and model pills when the terminal is only 40 columns wide', () => {
    const frame = plain(scene('status'), 'mono', 40);
    expect(frame).toContain('Sandboxed');
    expect(frame).toContain('gpt-5.6-luna');
    expect(frame).not.toContain('$0.12');
  });

  it('drops the lowest-tier numbers first as the terminal narrows', () => {
    const wide = plain(scene('status'), 'mono', 100);
    const narrow = plain(scene('status'), 'mono', 60);
    expect(wide).toContain('52% cached');
    expect(narrow).not.toContain('52% cached');
    expect(narrow).toContain('ctx ▰');
  });

  it('puts alerts on their own row only when there is something to say', () => {
    const quiet = lines(plain(scene('status'), 'mono', 120));
    const alerting = lines(plain(scene('status-alerts'), 'mono', 120));
    expect(quiet.join('\n')).not.toContain('cache miss risk');
    const alertRow = alerting.find((line) => line.includes('cache miss risk'))!;
    expect(alertRow).toContain('▲ Possible stall: shell ×6');
    expect(alertRow).not.toContain('gpt-5.6-luna');
  });

  it('marks a YOLO-style danger safety pill with a triangle instead of a diamond', () => {
    const view = {
      columns: 80,
      config: [{ id: 'safety', text: 'YOLO', tone: 'danger' as const, bold: true }],
      metrics: [],
      alerts: [],
      quotaText: '',
      gauges: {
        contextPercent: undefined,
        contextUsedTokens: undefined,
        contextWindowTokens: undefined,
        cachePercent: undefined,
        quotaWindows: [],
      },
    };
    const target = adHoc(() => <cardsSkin.StatusBar {...view} />);
    expect(plain(target, 'mono', 80)).toContain('▲ YOLO');
  });
});

describe('cards: tool group summary', () => {
  it('shows one marked line per summary, and the failure line beneath a partial run', () => {
    const frame = lines(plain(scene('tool-group'), 'mono', 100));
    expect(frame.some((line) => line.startsWith('✓ Searched for 1 pattern, read 1 file, ran 1 shell command'))).toBe(
      true,
    );
    const failure = frame.findIndex((line) => line.startsWith('✗ 1 failed: pnpm test'));
    expect(failure).toBeGreaterThan(0);
    expect(frame[failure - 1].startsWith('✓')).toBe(true);
  });
});
