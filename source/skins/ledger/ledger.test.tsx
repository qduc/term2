// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { type ReactElement } from 'react';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import { Box, Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandMessage from '../../components/message/CommandMessage.js';
import { THEMES, type ThemeName } from '../../theme/palettes.js';
import { SCENES, renderScene, type Scene } from '../testing/scenes.js';
import { BRAILLE_SPINNER } from '../shared/spinner.js';
import type { ApprovalChoicesProps, StatusView } from '../types.js';
import { ledgerSkin } from './index.js';

/**
 * Behaviour specific to the ledger skin, observed through the real containers and the
 * shared scenes wherever a container supplies the data, and through the slot itself where
 * only a skin sees it (a spinner frame, a gauge at an exact percentage).
 *
 * Width-dependent choices read the terminal's own column count, which Ink's string
 * renderer does not provide, so the tests set it the way a real terminal would.
 */

const originalColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
const originalChalkLevel = chalk.level;

beforeEach(() => {
  // Ink's string renderer unmounts without flushing passive-effect cleanups, so a spinner's
  // interval would outlive its test and update an unmounted root; fake timers never fire it.
  vi.useFakeTimers();
  chalk.level = 3;
});

afterEach(() => {
  vi.useRealTimers();
  chalk.level = originalChalkLevel;
  if (originalColumnsDescriptor) Object.defineProperty(process.stdout, 'columns', originalColumnsDescriptor);
  else delete (process.stdout as { columns?: number }).columns;
});

const scene = (id: string): Scene => SCENES.find((candidate) => candidate.id === id)!;

function render(node: ReactElement | Scene, theme: ThemeName, columns: number): string {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
  const target: Scene =
    'node' in node && typeof node.node === 'function'
      ? (node as Scene)
      : { id: 'adhoc', description: '', node: () => node as ReactElement, mustContain: [] };
  return renderScene(target, { skin: ledgerSkin, theme, columns });
}

const plain = (frame: string): string[] => stripVTControlCharacters(frame).split('\n');

/** The truecolor foreground escape for a colour, as chalk writes it. */
const fg = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
};

/** The foreground in effect where `text` first appears in a coloured frame. */
function colourAt(frame: string, text: string): string | undefined {
  const at = frame.indexOf(text);
  if (at === -1) return undefined;
  const matches = [...frame.slice(0, at).matchAll(/\u001b\[38;2;\d+;\d+;\d+m/g)];
  return matches.at(-1)?.[0];
}

const dark = THEMES.dark;

const statusView = (overrides: Partial<StatusView['gauges']> = {}): StatusView => ({
  columns: 100,
  config: [
    { id: 'provider-model', text: 'Codex/gpt-5.6-luna', tone: 'accent' },
    { id: 'safety', text: 'Sandboxed', tone: 'success', bold: true, separator: 'group' },
  ],
  metrics: [],
  alerts: [],
  quotaText: '',
  gauges: {
    contextPercent: 40,
    contextUsedTokens: 108_800,
    contextWindowTokens: 272_000,
    cachePercent: undefined,
    quotaWindows: [],
    ...overrides,
  },
});

const renderStatus = (view: StatusView, theme: ThemeName = 'dark'): string =>
  render(<ledgerSkin.StatusBar {...view} />, theme, view.columns);

describe('ledger skin: tool rows', () => {
  const calls = (
    <Box flexDirection="column">
      <CommandMessage
        command="read_file"
        toolName="read_file"
        toolArgs={{ path: 'src/auth.ts' }}
        status="completed"
        success
        output="ok"
        displayMode="concise"
      />
      <CommandMessage
        command="rg -n token src"
        toolName="shell"
        toolArgs={{ command: 'rg -n token src' }}
        status="completed"
        success
        output="ok"
        displayMode="concise"
      />
      <CommandMessage
        command="grep"
        toolName="grep"
        toolArgs={{ pattern: 'expiresAt', path: 'src' }}
        status="completed"
        success
        output="ok"
        displayMode="concise"
      />
    </Box>
  );

  it('start the action in the same column whatever the tool is called', () => {
    const rows = plain(render(calls, 'dark', 100)).filter((line) => /^[✓✗]/.test(line));
    expect(rows).toHaveLength(3);
    const columnOf = (row: string, needle: string) => row.indexOf(needle);
    const starts = [columnOf(rows[0]!, 'Read'), columnOf(rows[1]!, 'rg -n'), columnOf(rows[2]!, 'Searched')];
    expect(new Set(starts).size).toBe(1);
    expect(starts[0]).toBeGreaterThan(4);
  });

  it('keeps the tool name in its own column, and clips a name that is too long for it', () => {
    const rows = plain(render(calls, 'dark', 100));
    expect(rows.find((row) => row.includes('read_file'))).toMatch(/^✓ read_file\s+Read/);

    const long = (
      <CommandMessage
        command="x"
        toolName="memory_retrieve_everything_ever"
        status="completed"
        success
        output="ok"
        displayMode="concise"
      />
    );
    const clipped = plain(render(long, 'dark', 60)).find((row) => row.startsWith('✓'))!;
    expect(clipped).toContain('…');
    expect(clipped.length).toBeLessThanOrEqual(60);
  });

  it('drops the name column on a narrow terminal and keeps the action', () => {
    const rows = plain(render(scene('tools-concise'), 'dark', 40));
    expect(rows[0]).toMatch(/^✓ rg -n "expiresAt" src/);
  });

  it('shows a spinner for a running call, from the shared frames, and no static glyph', () => {
    const frame = stripVTControlCharacters(
      render(
        <ledgerSkin.ToolHeader status="running" display="concise" toolName="shell" action={<Text>pnpm build</Text>} />,
        'dark',
        100,
      ),
    );
    expect(BRAILLE_SPINNER.some((glyph) => frame.startsWith(glyph))).toBe(true);
    expect(frame).not.toContain('◐');
    expect(frame).toContain('pnpm build');
  });

  it('keeps meaning in glyphs when there is no colour', () => {
    const frame = stripVTControlCharacters(render(scene('tools-concise'), 'mono', 100));
    expect(frame).toMatch(/✓ shell\s+rg -n "expiresAt" src/);
    expect(frame).toMatch(/✗ shell\s+pnpm test auth/);
    expect(frame).toContain('DENIED');
    const pending = stripVTControlCharacters(
      render(<ledgerSkin.ToolHeader status="pending" display="concise" toolName="shell" action="make" />, 'mono', 100),
    );
    expect(pending).toMatch(/^○ shell\s+make/);
  });

  it('frames standard output with a gutter that is heavier when the call failed', () => {
    const lines = plain(render(scene('tools-standard'), 'mono', 100));
    const okIndex = lines.findIndex((line) => line.includes('rg -n "expiresAt" src'));
    const failedIndex = lines.findIndex((line) => line.includes('pnpm test auth'));
    expect(lines[okIndex]).toMatch(/^│ /);
    expect(lines[failedIndex]).toMatch(/^┃ /);
  });
});

describe('ledger skin: tool groups', () => {
  it('lists the failures beneath the summary, marked with the failure glyph', () => {
    const lines = plain(render(scene('tool-group'), 'mono', 100));
    const partial = lines.findIndex((line) => line.includes('ran 1 shell command'));
    expect(lines[partial]).toMatch(/^✓ /);
    expect(lines[partial + 1]).toMatch(/^✗ .*pnpm test/);
  });
});

describe('ledger skin: messages', () => {
  it('puts a role chip on the user turn and a TERM² chip on its own line above the answer', () => {
    expect(plain(render(scene('user-message'), 'mono', 100))[0]).toMatch(/^\[YOU\] why do users/);

    const answer = plain(render(scene('assistant-answer'), 'mono', 100));
    const thinking = answer.findIndex((line) => line.includes('[THINKING]'));
    const term = answer.findIndex((line) => line.includes('TERM²'));
    expect(thinking).toBe(0);
    expect(answer[thinking + 1]).toContain('Checking the refresh path first.');
    expect(answer[term]!.trim()).toBe('TERM²');
    expect(answer[term + 1]).toContain('Findings');
    expect(ledgerSkin.assistantGutter).toBe(0);
  });

  it('draws the banner as one bar, with a bracketed mode badge only outside the default mode', () => {
    const banner = (mode: 'STANDARD' | 'PLAN') =>
      plain(
        render(
          <ledgerSkin.Banner
            version="1.2.3"
            mode={mode}
            mentor={false}
            providerLabel="Codex"
            model="gpt-5.6-luna"
            reasoningEffort="high"
            mentorModel={undefined}
            mentorReasoningEffort="default"
          />,
          'mono',
          100,
        ),
      ).filter((line) => line.trim() !== '');
    expect(banner('STANDARD')).toHaveLength(1);
    expect(banner('STANDARD')[0]).toContain('term²');
    expect(banner('STANDARD')[0]).not.toContain('[');
    expect(banner('PLAN')[0]).toContain('[PLAN]');
    expect(banner('PLAN')[0]).toContain('Codex/gpt-5.6-luna high');
  });
});

describe('ledger skin: live region', () => {
  const working = (width: number) =>
    stripVTControlCharacters(
      render(
        <ledgerSkin.WorkingIndicator
          phase="thinking"
          elapsedSeconds={12}
          tokensPerSecond={48.2}
          toolName={undefined}
          argumentChars={undefined}
          dotCount={1}
        />,
        'dark',
        width,
      ),
    );

  it('shows a spinner, the phase, elapsed time, rate and the interrupt hint', () => {
    const frame = working(100);
    expect(BRAILLE_SPINNER.some((glyph) => frame.startsWith(glyph))).toBe(true);
    expect(frame).toContain('Thinking');
    expect(frame).toContain('12s');
    expect(frame).toContain('48.2 tok/s');
    expect(frame).toContain('esc to interrupt');
  });

  it('drops the interrupt hint, not the facts, when the line would not fit', () => {
    const frame = working(30);
    expect(frame).not.toContain('esc to interrupt');
    expect(frame).toContain('12s');
    expect(frame).toContain('48.2 tok/s');
  });

  it('sizes each prompt marker to the width the input budgets for it', () => {
    const marker = (mode: 'input' | 'shell' | 'rejection') =>
      stripVTControlCharacters(render(<ledgerSkin.PromptMarker mode={mode} />, 'mono', 100));
    expect(marker('input')).toBe('❯ ');
    expect(marker('shell')).toBe('! ');
    expect(marker('rejection')).toBe('Why? ');
  });

  it('puts the input on a full-width band', () => {
    const band = render(
      <ledgerSkin.InputFrame>
        <Text>typed</Text>
      </ledgerSkin.InputFrame>,
      'dark',
      40,
    );
    expect(band).toContain(`\u001b[48;2;30;41;59m`);
    expect(stripVTControlCharacters(band).trimEnd()).toContain('typed');
  });
});

describe('ledger skin: approvals', () => {
  it('tells a caution from a danger by shape, not only by colour', () => {
    for (const theme of ['dark', 'mono'] as const) {
      const caution = stripVTControlCharacters(render(scene('approval-shell'), theme, 100));
      const danger = stripVTControlCharacters(render(scene('approval-danger'), theme, 100));

      expect(caution).toContain('APPROVAL');
      expect(caution).not.toContain('DANGER');
      expect(caution).not.toContain('▲');
      expect(caution).toContain('│');
      expect(caution).not.toContain('┃');

      expect(danger).toContain('▲ DANGER');
      expect(danger).not.toContain('APPROVAL');
      expect(danger).toContain('┃');
    }
  });

  it('colours the rule beside the request in the tone of the request', () => {
    const caution = render(scene('approval-shell'), 'dark', 100);
    const danger = render(scene('approval-danger'), 'dark', 100);
    expect(colourAt(caution, '│')).toBe(fg(dark.warning!));
    expect(colourAt(danger, '┃')).toBe(fg(dark.danger!));
  });

  const choices = (overrides: Partial<ApprovalChoicesProps> = {}): ReactElement => (
    <ledgerSkin.ApprovalChoices
      question="Allow this action?"
      options={[
        { label: 'Allow once', tone: 'success' },
        { label: 'Deny', tone: 'danger' },
      ]}
      selectedIndex={0}
      layout="two-pane"
      description={{ title: 'Allow once', text: 'Run this call one time.' }}
      {...overrides}
    />
  );

  it('lays options out as numbered chips on one row, the selected one marked, then describes it', () => {
    const lines = plain(render(choices(), 'mono', 100)).filter((line) => line.trim() !== '');
    expect(lines[0]).toBe('Allow this action?');
    expect(lines[1]).toMatch(/❯ 1 Allow once\s+\[2 Deny\]/);
    expect(lines[2]).toBe('↳ Run this call one time.');

    const moved = plain(render(choices({ selectedIndex: 1 }), 'mono', 100));
    expect(moved.join('\n')).toMatch(/\[1 Allow once\]\s+❯ 2 Deny/);
  });

  it('stacks the options on a narrow terminal, with nothing dropped', () => {
    const lines = plain(render(choices(), 'mono', 40)).filter((line) => line.trim() !== '');
    expect(lines.findIndex((line) => line.includes('Allow once'))).not.toBe(
      lines.findIndex((line) => line.includes('Deny')),
    );
    expect(lines.join('\n')).toContain('Run this call one time.');
  });

  it('shows the list-only layout without a description', () => {
    const lines = plain(render(choices({ layout: 'list', question: undefined, description: undefined }), 'mono', 100));
    expect(lines.join('\n')).not.toContain('↳');
    expect(lines.join('\n')).toContain('Deny');
  });
});

describe('ledger skin: status bar', () => {
  const contextColour = (percent: number): string | undefined => {
    const frame = renderStatus(statusView({ contextPercent: percent }));
    return colourAt(frame, `${percent}%`);
  };

  it('keeps the context gauge quiet below 75%, warns at 75 and goes to danger at 90', () => {
    expect(contextColour(74)).toBe(fg(dark.textMuted!));
    expect(contextColour(75)).toBe(fg(dark.warning!));
    expect(contextColour(89)).toBe(fg(dark.warning!));
    expect(contextColour(90)).toBe(fg(dark.danger!));
  });

  it('adds a glyph to a warning so it survives without colour', () => {
    expect(stripVTControlCharacters(renderStatus(statusView({ contextPercent: 74 }), 'mono'))).not.toContain('▲');
    expect(stripVTControlCharacters(renderStatus(statusView({ contextPercent: 75 }), 'mono'))).toContain('▲ 75%');
    expect(stripVTControlCharacters(renderStatus(statusView({ contextPercent: 95 }), 'mono'))).toContain('▲ 95%');
  });

  it('draws the context gauge with used and window tokens when there is room', () => {
    const wide = plain(renderStatus(statusView({ contextPercent: 40 }), 'mono')).join('\n');
    expect(wide).toMatch(/ctx ▰▰▱▱▱▱ 40% 109k\/272k/);
  });

  it('puts a filled, bracket-free safety chip first and keeps its text', () => {
    const lines = plain(renderStatus(statusView(), 'mono'));
    expect(lines[1]).toMatch(/^\s*Sandboxed\s/);
    expect(renderStatus(statusView(), 'dark')).toContain('\u001b[7m');
  });

  it('renders each quota window as a mini gauge with its reset time', () => {
    const view = statusView({
      quotaWindows: [
        { label: '5H', percent: 42, resetText: '09:11' },
        { label: '7D', percent: 91, resetText: '10/05' },
      ],
    });
    const frame = renderStatus(view, 'dark');
    const text = stripVTControlCharacters(frame);
    expect(text).toContain('5H ▰▰▰▱▱▱▱▱ 42% → 09:11');
    expect(text).toContain('7D ▰▰▰▰▰▰▰▱ ▲ 91% → 10/05');
    // The 91% window is in the danger tone, the 42% one is not.
    expect(colourAt(frame, '91%')).toBe(fg(dark.danger!));
    expect(colourAt(frame, '42%')).toBe(fg(dark.textMuted!));
  });

  it('keeps every quota window when the row cannot hold them side by side', () => {
    const lines = plain(
      renderStatus(
        {
          ...statusView({
            quotaWindows: [
              { label: 'Roll', percent: 12, resetText: '4h' },
              { label: 'Week', percent: 50, resetText: '2d' },
              { label: 'Month', percent: 80, resetText: '20d' },
            ],
          }),
          columns: 40,
        },
        'mono',
      ),
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    const text = lines.join('\n');
    for (const label of ['Roll', 'Week', 'Month']) expect(text).toContain(label);
  });

  it('puts configuration and metrics on one row when wide and stacks them when not', () => {
    const wide = plain(render(scene('status'), 'mono', 160)).filter((line) => line.includes('Sandboxed'));
    expect(wide).toHaveLength(1);
    expect(wide[0]).toContain('ctx');

    const medium = plain(render(scene('status'), 'mono', 80));
    const configRow = medium.find((line) => line.includes('Sandboxed'))!;
    expect(configRow).not.toContain('ctx');
    expect(medium.some((line) => line.includes('ctx'))).toBe(true);
  });

  it('drops the lowest-tier chips first on a narrow terminal and keeps the model', () => {
    const narrow = plain(render(scene('status'), 'mono', 40)).join('\n');
    expect(narrow).toContain('Sandboxed');
    expect(narrow).toContain('gpt-5.6-luna');
    expect(narrow).not.toContain('48.2t/s');
    expect(narrow).not.toContain('~$0.12');
    for (const line of narrow.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('shows alerts on a row of their own, in their tones', () => {
    const frame = render(scene('status-alerts'), 'dark', 100);
    const rows = plain(frame);
    const alertRow = rows.find((line) => line.includes('cache miss risk'))!;
    expect(alertRow).toContain('Possible stall');
    expect(alertRow).not.toContain('Sandboxed');
    expect(colourAt(frame, '▲ cache miss risk')).toBe(fg(dark.warning!));
  });

  it('marks a danger safety level with a glyph as well as the tone', () => {
    const view: StatusView = {
      ...statusView(),
      config: [{ id: 'safety', text: 'YOLO', tone: 'danger', bold: true }],
    };
    expect(stripVTControlCharacters(renderStatus(view, 'mono'))).toContain('▲ YOLO');
  });

  it('never drops a segment it does not know about', () => {
    const view: StatusView = {
      ...statusView(),
      config: [...statusView().config, { id: 'future-thing', text: 'ZZ-new', tone: 'accent' }],
    };
    expect(stripVTControlCharacters(renderStatus(view, 'mono'))).toContain('ZZ-new');
  });
});
