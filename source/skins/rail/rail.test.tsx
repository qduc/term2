// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act, type ReactElement } from 'react';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { Text, renderToString } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { THEMES, type ThemeName } from '../../theme/palettes.js';
import { ThemeProvider } from '../../theme/ThemeContext.js';
import { BRAILLE_SPINNER } from '../shared/spinner.js';
import { SCENES, renderScene } from '../testing/scenes.js';
import type {
  ApprovalChoicesProps,
  ApprovalFrameProps,
  BannerView,
  StatusView,
  ToolHeaderProps,
  WorkingIndicatorView,
} from '../types.js';
import { railSkin } from './index.js';

const terminal = vi.hoisted(() => ({ columns: 100 }));
vi.mock('../../hooks/use-terminal-columns.js', () => ({ useTerminalColumns: () => terminal.columns }));

const scene = (id: string) => SCENES.find((candidate) => candidate.id === id)!;
const plain = (value: string) => stripVTControlCharacters(value);

/** The scene as plain text, through the real containers. */
const sceneText = (id: string, theme: ThemeName = 'mono', columns = 80) =>
  plain(renderScene(scene(id), { skin: 'rail', theme, columns }));

/** One slot on its own, as plain text. */
const slotText = (node: ReactElement, theme: ThemeName = 'mono', columns = 100) =>
  plain(
    renderToString(<ThemeProvider theme={THEMES[theme]}>{node}</ThemeProvider>, {
      columns,
    }),
  );

/** One slot with real ANSI attributes: ink-testing and vitest run without a colour level. */
const slotAnsi = (node: ReactElement, theme: ThemeName = 'dark', columns = 100) => {
  const original = chalk.level;
  chalk.level = 3;
  try {
    return renderToString(<ThemeProvider theme={THEMES[theme]}>{node}</ThemeProvider>, { columns });
  } finally {
    chalk.level = original;
  }
};

const fg = (hex: string | undefined) => {
  const value = hex!.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `\u001B[38;2;${r};${g};${b}m`;
};
const bgEscape = /\u001B\[48;/;
/** Ink writes bold before the colour: `ESC[1m` then `ESC[38;2;…m`. */
const BOLD = '\u001B[1m';

afterEach(() => {
  terminal.columns = 100;
  vi.useRealTimers();
});

describe('rail skin: messages', () => {
  it('draws a user message as bold text behind an accent prompt, with no background band', () => {
    const node = <railSkin.UserMessage text="why do users get logged out?" />;
    expect(plain(slotAnsi(node))).toContain('❯ why do users get logged out?');
    const ansi = slotAnsi(node, 'dark');
    expect(ansi).toContain(fg(THEMES.dark.accent));
    expect(ansi).not.toMatch(bgEscape);
    expect(slotAnsi(node, 'light')).not.toMatch(bgEscape);
  });

  it('keeps the continuation of a wrapped user message under the words, not under the prompt', () => {
    const text = slotText(<railSkin.UserMessage text="alpha beta gamma delta epsilon zeta" />, 'mono', 20);
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith('❯ ')).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith('  '))).toBe(true);
  });

  it('prints answers bare, with no gutter for markdown to account for', () => {
    expect(railSkin.assistantGutter).toBe(0);
    expect(
      slotText(
        <railSkin.AssistantFrame kind="answer">
          <Text>hello there</Text>
        </railSkin.AssistantFrame>,
      ).trim(),
    ).toBe('hello there');
  });
});

describe('rail skin: banner', () => {
  const banner: BannerView = {
    version: '1.2.3',
    mode: 'STANDARD',
    mentor: false,
    providerLabel: 'Codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    mentorModel: undefined,
    mentorReasoningEffort: 'none',
  };

  it('is one line with the effort in parentheses and no mode badge in the default mode', () => {
    const text = slotText(<railSkin.Banner {...banner} />).trim();
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toBe('term² v1.2.3 · Codex/gpt-5.6-luna (high)');
  });

  it('shows a badge only when the mode is not the default, and mentor details when mentoring', () => {
    const plan = slotText(<railSkin.Banner {...banner} mode="PLAN" />);
    expect(plan).toContain('PLAN');
    const mentor = slotText(
      <railSkin.Banner {...banner} mentor mentorModel="claude-opus" mentorReasoningEffort="medium" />,
    );
    expect(mentor).toContain('MENTOR');
    expect(mentor).toContain('claude-opus (medium)');
  });

  it('draws a badge in mono by inverting it, since there is no badge colour', () => {
    const original = chalk.level;
    chalk.level = 3;
    try {
      const ansi = renderToString(
        <ThemeProvider theme={THEMES.mono}>
          <railSkin.Banner {...banner} mode="PLAN" />
        </ThemeProvider>,
        { columns: 100 },
      );
      expect(ansi).toContain('\u001B[7m');
    } finally {
      chalk.level = original;
    }
  });

  it('drops the version first, then moves the model to its own line, when the terminal is narrow', () => {
    terminal.columns = 36;
    const text = slotText(<railSkin.Banner {...banner} />, 'mono', 36).trim();
    expect(text).not.toContain('v1.2.3');
    expect(text).toContain('Codex/gpt-5.6-luna (high)');
    terminal.columns = 20;
    const narrow = slotText(<railSkin.Banner {...banner} />, 'mono', 20)
      .trim()
      .split('\n');
    expect(narrow[0].trim()).toBe('term²');
  });
});

describe('rail skin: tool calls', () => {
  it('names the tool and carries status in glyphs, so mono still reads', () => {
    const text = sceneText('tools-standard', 'mono');
    expect(text).toMatch(/✓ shell rg -n "expiresAt" src/);
    expect(text).toMatch(/✗ shell pnpm test auth/);
    expect(text).toMatch(/✗ shell git push --force origin main/);
  });

  it('puts a rail down every line of a standard call, heavier when it failed', () => {
    const lines = sceneText('tools-standard', 'mono').split('\n');
    const line = (needle: string) => lines.find((candidate) => candidate.includes(needle))!;
    expect(line('src/auth.ts:42')).toMatch(/^▎ /);
    expect(line('FAIL src/auth.test.ts')).toMatch(/^▌ /);
    expect(line('DENIED')).toMatch(/^▌ /);
  });

  it('colours the rail by status', () => {
    const original = chalk.level;
    chalk.level = 3;
    try {
      const ansi = renderScene(scene('tools-standard'), { skin: 'rail', theme: 'dark', columns: 80 });
      expect(ansi).toContain(`${fg(THEMES.dark.toolStatus.completed)}▎`);
      expect(ansi).toContain(`${fg(THEMES.dark.toolStatus.failed)}▌`);
    } finally {
      chalk.level = original;
    }
  });

  it('leaves a succeeded concise call as a bare line, and frames only a failed one', () => {
    const lines = sceneText('tools-concise', 'mono').split('\n');
    const line = (needle: string) => lines.find((candidate) => candidate.includes(needle))!;
    expect(line('rg -n "expiresAt"')).toMatch(/^✓ shell /);
    expect(line('pnpm test auth')).toMatch(/^▌ ✗ shell /);
    expect(line('FAIL src/auth.test.ts')).toMatch(/^▌ /);
  });

  const header = (props: Partial<ToolHeaderProps>): ReactElement => (
    <railSkin.ToolHeader status="completed" display="standard" toolName="grep" action="Searched foo" {...props} />
  );

  it('shows the tool name in standard display, and for shell in concise, but not twice for other concise tools', () => {
    expect(slotText(header({}))).toContain('grep Searched foo');
    expect(slotText(header({ display: 'concise' }))).not.toContain('grep');
    expect(slotText(header({ display: 'concise', toolName: undefined, action: 'ls' }))).toContain('shell ls');
  });

  it('keeps the in-flight meta and trailing detail beside the action', () => {
    const text = slotText(
      header({
        status: 'running',
        meta: ' (12s)',
        trailing: ' (+3 -1)',
        toolName: 'search_replace',
        action: 'Edited a',
      }),
    );
    expect(text).toContain('search_replace Edited a (12s) (+3 -1)');
  });

  it('wraps a long command under the command, not under the glyph', () => {
    const text = slotText(header({ toolName: 'shell', action: 'one two three four five six seven' }), 'mono', 24);
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith('  '))).toBe(true);
  });

  it('shows a spinner for a running call that advances, and a static glyph once settled', async () => {
    vi.useFakeTimers();
    const view = await renderInAct(<ThemeProvider theme={THEMES.mono}>{header({ status: 'running' })}</ThemeProvider>);
    const glyph = () => plain(view.lastFrame() ?? '').trim()[0];
    expect(glyph()).toBe(BRAILLE_SPINNER[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(glyph()).toBe(BRAILLE_SPINNER[1]);
    expect(plain(view.lastFrame() ?? '')).not.toContain('◐');

    await act(async () => {
      view.rerender(<ThemeProvider theme={THEMES.mono}>{header({ status: 'completed' })}</ThemeProvider>);
    });
    expect(glyph()).toBe('✓');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not tick for a call that is merely queued', async () => {
    vi.useFakeTimers();
    const view = await renderInAct(<ThemeProvider theme={THEMES.mono}>{header({ status: 'pending' })}</ThemeProvider>);
    expect(plain(view.lastFrame() ?? '').trim()[0]).toBe('○');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('summarises a group on one quiet line, with the failures on the line below', () => {
    const lines = sceneText('tool-group', 'mono', 100)
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines[0]).toMatch(/^✓ Searched/);
    expect(lines[1]).toMatch(/^✓ Searched.*shell command/);
    expect(lines[2]).toMatch(/^✗ .*failed/);
  });
});

describe('rail skin: live region', () => {
  const working = (view: Partial<WorkingIndicatorView>): ReactElement => (
    <railSkin.WorkingIndicator
      phase="thinking"
      elapsedSeconds={12}
      tokensPerSecond={undefined}
      toolName={undefined}
      argumentChars={undefined}
      dotCount={0}
      {...view}
    />
  );

  it('says what the agent is doing, for how long, and how to stop it', () => {
    expect(slotText(working({}))).toContain('Thinking… 12s');
    expect(slotText(working({}))).toContain('esc to interrupt');
    expect(slotText(working({ phase: 'generating', tokensPerSecond: 48.2 }))).toContain('Generating… 12s (48.2 tok/s)');
    expect(slotText(working({ phase: 'tool_call', toolName: 'apply_patch', argumentChars: 1240 }))).toContain(
      'Calling tool apply_patch… 12s (1240 chars)',
    );
  });

  it('drops the interrupt hint, not the status, when the line does not fit', () => {
    terminal.columns = 20;
    const text = slotText(working({}), 'mono', 20);
    expect(text).toContain('Thinking… 12s');
    expect(text).not.toContain('esc to interrupt');
  });

  it('animates the spinner only while working', async () => {
    vi.useFakeTimers();
    const view = await renderInAct(<ThemeProvider theme={THEMES.mono}>{working({})}</ThemeProvider>);
    const first = plain(view.lastFrame() ?? '').trim()[0];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(plain(view.lastFrame() ?? '').trim()[0]).not.toBe(first);
  });

  it('seats the prompt between two hairlines', () => {
    const lines = sceneText('live-idle', 'mono', 60).split('\n');
    const hairlines = lines.reduce<number[]>(
      (found, line, index) => (/^─{60}$/.test(line) ? [...found, index] : found),
      [],
    );
    expect(hairlines).toHaveLength(2);
    const prompt = lines.findIndex((line) => line.startsWith('❯'));
    expect(hairlines[0]).toBeLessThan(prompt);
    expect(hairlines[1]).toBe(prompt + 1);
  });

  it('marks the three prompt modes by glyph, not only colour', () => {
    expect(slotText(<railSkin.PromptMarker mode="input" />)).toBe('❯');
    expect(slotText(<railSkin.PromptMarker mode="shell" />)).toBe('!');
    expect(slotText(<railSkin.PromptMarker mode="rejection" />)).toBe('Why?');
  });

  it('writes hints dim and dot-separated, wrapping between hints rather than inside one', () => {
    const hints = [
      ['⏎', 'steer'],
      ['alt+⏎', 'queue'],
      ['Esc', 'interrupts the turn'],
    ] as const;
    expect(slotText(<railSkin.Hints hints={hints} />)).toBe('⏎ steer · alt+⏎ queue · Esc interrupts the turn');
    const lines = slotText(<railSkin.Hints hints={hints} />, 'mono', 24).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => !line.startsWith(' ·') && !line.trim().startsWith('the turn'))).toBe(true);
  });

  it('colours a hint key in the role the container named', () => {
    const ansi = slotAnsi(<railSkin.Hints hints={[['Alt+⏎', 'queue', 'accentAlt']]} />);
    expect(ansi).toContain(`${fg(THEMES.dark.accentAlt)}Alt+⏎`);
  });
});

describe('rail skin: approvals', () => {
  const frame = (tone: ApprovalFrameProps['tone']): ReactElement => (
    <railSkin.ApprovalFrame tone={tone} header="Agent wants to run: shell">
      <Text>{'the command\nand its choices'}</Text>
    </railSkin.ApprovalFrame>
  );

  it('tells danger from caution by shape in mono: a solid rail and a ▲ marker', () => {
    const caution = slotText(frame('caution'));
    const danger = slotText(frame('danger'));
    expect(caution).toContain('▌');
    expect(caution).not.toContain('█');
    expect(caution).not.toContain('▲');
    expect(danger).toContain('█');
    expect(danger).not.toContain('▌');
    expect(danger).toContain('▲ Agent wants to run: shell');
  });

  it('runs the rail down every line of the request', () => {
    const lines = slotText(frame('caution')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('▌ '))).toBe(true);
  });

  it('colours the rail warning for caution and danger for danger', () => {
    expect(slotAnsi(frame('caution'))).toContain(`${fg(THEMES.dark.warning)}▌`);
    expect(slotAnsi(frame('danger'))).toContain(`${fg(THEMES.dark.danger)}█`);
  });

  it('keeps the rail intact through the real approval container, danger and caution', () => {
    expect(
      sceneText('approval-shell')
        .split('\n')
        .filter(Boolean)
        .every((line) => line.startsWith('▌')),
    ).toBe(true);
    expect(
      sceneText('approval-danger')
        .split('\n')
        .filter(Boolean)
        .every((line) => line.startsWith('█')),
    ).toBe(true);
    expect(sceneText('approval-danger')).toContain('▲ Docker host control');
  });

  const choices = (props: Partial<ApprovalChoicesProps> = {}): ReactElement => (
    <railSkin.ApprovalChoices
      question="Allow this action?"
      layout="two-pane"
      selectedIndex={0}
      options={[
        { label: 'Allow once', tone: 'success' },
        { label: 'Deny', tone: 'danger' },
      ]}
      description={{ title: 'Allow once', text: 'Allow this tool call.' }}
      {...props}
    />
  );

  it('lists the options numbered under the question, with the selection marked by ❯', () => {
    const lines = slotText(choices()).split('\n');
    expect(lines).toEqual(['Allow this action?', '❯ 1 Allow once', '  2 Deny', '    Allow this tool call.']);
    expect(slotText(choices({ selectedIndex: 1 })).split('\n')).toContain('❯ 2 Deny');
  });

  it('shows the description of the selected option as one dim line, not a side pane', () => {
    const text = slotText(choices({ description: { title: 'Deny', text: 'Deny this tool call.' } }), 'mono', 120);
    expect(text).toContain('Deny this tool call.');
    expect(text.split('\n').filter((line) => line.includes('Deny this tool call.'))).toHaveLength(1);
    expect(text).not.toMatch(/│|┃/);
  });

  it('draws no description line for the list-only layout', () => {
    expect(slotText(choices({ layout: 'list', question: undefined, description: undefined }))).toBe(
      '❯ 1 Allow once\n  2 Deny',
    );
  });

  it('shows the selected row in its own tone, and bold, so a Deny reads as one', () => {
    const ansi = slotAnsi(choices({ selectedIndex: 1 }));
    expect(ansi).toContain(`${BOLD}${fg(THEMES.dark.danger)}Deny`);
    expect(slotAnsi(choices())).toContain(`${BOLD}${fg(THEMES.dark.success)}Allow once`);
  });

  it('wraps a long option under its label, inside the rail, at 40 columns', () => {
    const text = sceneText('approval-patch', 'mono', 40);
    expect(text.split('\n').every((line) => Array.from(line).length <= 40)).toBe(true);
  });
});

describe('rail skin: status bar', () => {
  const segment = (id: string, text: string, extra: object = {}) => ({ id, text, ...extra });
  const status = (overrides: Partial<StatusView> = {}, percent: number | undefined = 40): StatusView => ({
    columns: 120,
    config: [
      segment('mode', '', { tone: 'accent', bold: true }),
      segment('queue', '', { tone: 'accent', tier: 3 }),
      segment('provider-model', 'Codex/gpt-5.6-luna', { tone: 'accent' }),
      segment('reasoning', ' · high', { tone: 'warning', tier: 2 }),
      segment('safety', 'Sandboxed', { tone: 'success', bold: true }),
    ],
    metrics: [
      segment('tokens', '↑229k ↓1.3k', { tone: 'textSubtle', tier: 4 }),
      segment('speed', '(48.2 tok/s)', { tone: 'textSubtle', tier: 0 }),
      segment('cache', '52% cached', { tone: 'textSubtle', tier: 1 }),
      segment('context', 'Ctx 229k/400k', { tone: 'textSubtle', tier: 3 }),
      segment('cost', '~$0.12', { tone: 'textSubtle', tier: 2 }),
    ],
    alerts: [],
    quotaText: '',
    gauges: {
      contextPercent: percent,
      contextUsedTokens: 229_000,
      contextWindowTokens: 400_000,
      cachePercent: 52,
      quotaWindows: [],
    },
    ...overrides,
  });
  const bar = (view: StatusView, theme: ThemeName = 'mono') =>
    slotText(<railSkin.StatusBar {...view} />, theme, view.columns);

  it('is a single line when nothing is wrong, in the order safety, model, context, cost, cache', () => {
    expect(bar(status()).trimEnd()).toBe(
      'Sandboxed · Codex/gpt-5.6-luna high · ctx ▰▰▱▱▱ 40% · ~$0.12 · 52% cached · 48.2 tok/s',
    );
  });

  it('draws the context as a gauge: quiet below 75%, warm and bold from 75%, with a ▲ from 90%', () => {
    const ansi = (percent: number) => slotAnsi(<railSkin.StatusBar {...status({}, percent)} />);

    // Below 75%: the label and the bar share the quiet colour, and nothing is bold.
    expect(ansi(74)).toContain(`${fg(THEMES.dark.textSubtle)}ctx ▰▰▰▰▱ 74%`);
    expect(ansi(74)).not.toContain(`${BOLD}${fg(THEMES.dark.warning)}`);

    expect(ansi(75)).toContain(`${BOLD}${fg(THEMES.dark.warning)}▰▰▰▰▱ 75%`);
    expect(ansi(89)).toContain(`${BOLD}${fg(THEMES.dark.warning)}▰▰▰▰▱ 89%`);

    expect(ansi(90)).toContain(`${BOLD}${fg(THEMES.dark.danger)}▰▰▰▰▰ 90% ▲`);
  });

  it('carries the warning in mono by weight and glyph: the ▲ appears only from 90%', () => {
    expect(bar(status({}, 89))).not.toContain('▲');
    expect(bar(status({}, 90))).toContain('90% ▲');
  });

  it('never drops a context that is filling up, but drops a quiet one before the model or safety', () => {
    const narrow = (percent: number) => bar(status({ columns: 40 }, percent));
    expect(narrow(40)).not.toContain('ctx');
    expect(narrow(80)).toContain('ctx ▰▰▰▰▱ 80%');
    for (const percent of [40, 80]) {
      expect(narrow(percent)).toContain('Sandboxed');
      expect(narrow(percent)).toContain('Codex/gpt-5.6-luna');
    }
  });

  it('drops low-priority segments by tier as the terminal narrows', () => {
    const at = (columns: number) => bar(status({ columns }));
    // The full line is 86 columns; each step below drops the next-lowest tier.
    expect(at(120)).toContain('48.2 tok/s');
    expect(at(80)).not.toContain('tok/s');
    expect(at(80)).toContain('52% cached');
    expect(at(70)).not.toContain('cached');
    expect(at(70)).toContain('~$0.12');
    expect(at(58)).not.toContain('~$0.12');
    expect(at(58)).toContain('ctx');
    expect(at(58)).toContain(' high');
    // Effort (tier 2) goes before the context gauge (tier 3).
    expect(at(48)).not.toContain(' high');
    expect(at(48)).toContain('ctx');
  });

  it('never exceeds the terminal, however narrow', () => {
    for (const columns of [24, 30, 40, 60, 80, 120]) {
      for (const percent of [40, 95]) {
        const lines = bar(status({ columns }, percent)).split('\n');
        expect(Math.max(...lines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('adds a second line only for an alert, or for quota that does not fit beside the status', () => {
    expect(bar(status()).trimEnd().split('\n')).toHaveLength(1);

    const alert = bar(
      status({ alerts: [{ id: 'cache', parts: [{ text: '▲ cache miss risk ~230k', tone: 'warning', bold: true }] }] }),
    ).trimEnd();
    expect(alert.split('\n')).toHaveLength(2);
    expect(alert).toContain('▲ cache miss risk ~230k');

    const quota = bar(
      status({
        columns: 60,
        gauges: {
          ...status().gauges,
          quotaWindows: [
            { label: '5H', percent: 42, resetText: '3h' },
            { label: '7D', percent: 91, resetText: undefined },
          ],
        },
      }),
    ).trimEnd();
    expect(quota.split('\n')).toHaveLength(2);
    expect(quota).toContain('5H ▰▰▱▱▱ 42%→3h');
    expect(quota).toContain('7D ▰▰▰▰▰ 91%');

    // Wide enough, quota shares the status line instead of owning a row.
    const wide = bar(
      status({
        columns: 200,
        gauges: { ...status().gauges, quotaWindows: [{ label: '5H', percent: 42, resetText: '3h' }] },
      }),
    ).trimEnd();
    expect(wide.split('\n')).toHaveLength(1);
    expect(wide).toContain('5H ▰▰▱▱▱ 42%→3h');
  });

  it('through the real container: quota joins the status line, no padding', () => {
    const lines = sceneText('status', 'mono', 120).trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Sandboxed · \[Q:2\] · Codex\/gpt-5\.6-luna high · ctx ▰+▱* \d+%/);
    expect(lines.join(' ')).toMatch(/5H ▰+▱* 42%/);
  });
});
