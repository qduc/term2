// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatusBar from '../../components/layout/StatusBar.js';
import ChatMessage from '../../components/message/ChatMessage.js';
import { getModelContextWindow } from '../../providers/model-catalog/catalog.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { THEMES, type ThemeName } from '../../theme/palettes.js';
import { ThemeProvider } from '../../theme/ThemeContext.js';
import { SkinProvider } from '../SkinContext.js';
import { BRAILLE_SPINNER } from '../shared/spinner.js';
import { SCENES, renderScene, type Scene } from '../testing/scenes.js';
import type { ApprovalChoicesProps, BannerView, WorkingIndicatorView } from '../types.js';
import { zenSkin } from './index.js';

/**
 * What is specific to zen. The conformance suite already proves it fits and keeps
 * its content; these pin the design decisions that suite cannot see.
 */

const scene = (id: string): Scene => SCENES.find((candidate) => candidate.id === id)!;

/**
 * Width-dependent decisions in a skin read the terminal's column count, which a
 * string render does not have. Give it one, as a real terminal would.
 */
function withColumns<T>(columns: number, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else delete (process.stdout as { columns?: number }).columns;
  }
}

function render(target: Scene | ReactElement, columns = 80, theme: ThemeName = 'mono'): string {
  const subject: Scene =
    'node' in target && typeof target.node === 'function'
      ? (target as Scene)
      : { id: 'ad-hoc', description: '', node: () => target as ReactElement, mustContain: [] };
  return withColumns(columns, () => stripVTControlCharacters(renderScene(subject, { skin: 'zen', theme, columns })));
}

const linesOf = (frame: string): string[] => frame.split('\n').map((line) => line.trimEnd());
const widest = (frame: string): number => Math.max(...linesOf(frame).map((line) => Array.from(line).length));

const settings = (overrides: Record<string, unknown> = {}) =>
  createMockSettingsService({
    'agent.modelSelection': { model: 'gpt-5.6-luna', provider: 'codex' },
    'agent.reasoningEffort': 'high',
    'shell.autoApproveMode': 'auto',
    'sandbox.enabled': true,
    ...overrides,
  });

const CONTEXT_WINDOW = getModelContextWindow('codex', 'gpt-5.6-luna')!;
const promptTokensFor = (percent: number): number => Math.round((CONTEXT_WINDOW * percent) / 100);

const statusNode = (props: Partial<React.ComponentProps<typeof StatusBar>> = {}) => (
  <StatusBar settingsService={settings()} {...props} />
);

const statusAt = (percent: number, columns = 100): string =>
  render(
    statusNode({ lastUsage: { prompt_tokens: promptTokensFor(percent), completion_tokens: 10 } as never }),
    columns,
  );

describe('assistant frame', () => {
  const chat = (sender: 'bot' | 'reasoning', text: string, maxWidth?: number) => (
    <ChatMessage msg={{ id: sender, sender, text }} maxWidth={maxWidth} />
  );

  it('hangs an answer off a diamond and indents every following line to the same column', () => {
    const lines = linesOf(render(chat('bot', 'First line.\n\nSecond paragraph.')));
    expect(lines[0]).toBe('◆ First line.');
    const second = lines.find((line) => line.includes('Second paragraph.'))!;
    expect(second.indexOf('Second')).toBe(lines[0].indexOf('First'));
  });

  it('marks reasoning with a different shape than an answer, so the two differ without colour', () => {
    expect(linesOf(render(chat('reasoning', 'Weighing the options.')))[0]).toBe('◇ Weighing the options.');
  });

  it('declares at least the columns it indents, so markdown is narrowed to leave room', () => {
    const indent = linesOf(render(chat('bot', 'x')))[0].indexOf('x');
    expect(zenSkin.assistantGutter).toBeGreaterThanOrEqual(indent);
  });

  // Markdown wraps lists against the width of their container, and an indented
  // container exposed a line one cell too wide. Sweep the line length across the
  // edge so the frame is held to "never overflows", not to one lucky sentence.
  describe.each([40, 52, 60, 80])('markdown at %i columns', (columns) => {
    const items = Array.from(
      { length: 40 },
      (_, extra) => `- Tokens are never refreshed when \`expiresAt\` is inside the ${'x'.repeat(extra)}`,
    );
    const markdown = [
      ...items,
      '',
      '```ts',
      'export function isExpired(t: Token, skewMs = 30_000) { return t.expiresAt - Date.now() < skewMs; }',
      '```',
    ].join('\n');

    it('never overflows the terminal', () => {
      expect(widest(render(chat('bot', markdown, columns), columns))).toBeLessThanOrEqual(columns);
    });

    it('keeps every list item and the code block, wrapped rather than cut', () => {
      const frame = render(chat('bot', markdown, columns), columns);
      expect(frame.match(/•/g)).toHaveLength(items.length);
      expect(frame.replace(/\s+/g, ' ')).toContain('isExpired');
    });
  });
});

describe('user message and prompt', () => {
  it('is a bold line behind the same marker the prompt uses, with no band', () => {
    const frame = render(scene('user-message'));
    expect(linesOf(frame)[0]).toBe('› why do users get logged out after an hour?');
  });

  it('hangs a long message under its first word instead of wrapping under the marker', () => {
    const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const lines = linesOf(render(<ChatMessage msg={{ id: 'u', sender: 'user', text: long }} />, 40));
    expect(lines.length).toBeGreaterThan(1);
    for (const continuation of lines.slice(1)) expect(continuation.startsWith('  word')).toBe(true);
  });

  it.each([
    ['input', '›'],
    ['shell', '!'],
    ['rejection', 'why?'],
  ] as const)('marks %s mode with %s', (mode, marker) => {
    const Marker = zenSkin.PromptMarker;
    expect(render(<Marker mode={mode} />).trim()).toBe(marker);
  });

  it('keeps the width the input row assumes for each marker', () => {
    // The input component sizes its editable area from fixed prompt widths (2, 2 and 5).
    const Marker = zenSkin.PromptMarker;
    const widths = (['input', 'shell', 'rejection'] as const).map((mode) =>
      linesOf(
        render(
          <Box>
            <Marker mode={mode} />
            <Text>|</Text>
          </Box>,
        ),
      )[0].indexOf('|'),
    );
    expect(widths).toEqual([2, 2, 5]);
  });
});

describe('banner', () => {
  const view: BannerView = {
    version: '1.2.3',
    mode: 'STANDARD',
    mentor: false,
    providerLabel: 'Codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    mentorModel: undefined,
    mentorReasoningEffort: 'none',
  };
  const Banner = zenSkin.Banner;

  it('is the name, the version, and one line saying what it talks to', () => {
    const lines = linesOf(render(<Banner {...view} />)).filter(Boolean);
    expect(lines).toEqual(['term² v1.2.3', 'Codex/gpt-5.6-luna (high)']);
  });

  it('only names the mode when it is not the default', () => {
    expect(render(<Banner {...view} />)).not.toContain('STANDARD');
    expect(render(<Banner {...view} mode="PLAN" />)).toContain('PLAN');
  });

  it('keeps the mentor model when the mentor profile is active', () => {
    const frame = render(<Banner {...view} mentor mentorModel="gpt-5.6-sol" mentorReasoningEffort="low" />);
    expect(frame).toContain('MENTOR');
    expect(frame).toContain('gpt-5.6-sol');
  });
});

describe('tool calls', () => {
  const Header = zenSkin.ToolHeader;
  const header = (props: Partial<React.ComponentProps<typeof Header>> = {}) => (
    <Header status="completed" display="concise" toolName="shell" action="ls -la" {...props} />
  );

  it('shows a status glyph per outcome even without colour', () => {
    expect(
      render(header({ status: 'completed' }))
        .trim()
        .startsWith('✓'),
    ).toBe(true);
    expect(
      render(header({ status: 'failed' }))
        .trim()
        .startsWith('✗'),
    ).toBe(true);
    expect(
      render(header({ status: 'rejected' }))
        .trim()
        .startsWith('✗'),
    ).toBe(true);
    expect(
      render(header({ status: 'pending' }))
        .trim()
        .startsWith('○'),
    ).toBe(true);
  });

  it('has no tool-name column: the action is the whole line', () => {
    expect(render(header({ toolName: 'read_file', action: 'src/auth.ts' })).trim()).toBe('✓ src/auth.ts');
  });

  it('keeps the elapsed marker and trailing detail beside the action', () => {
    const frame = render(header({ status: 'running', meta: ' (12s)', trailing: ' (+3 -1)' }));
    expect(frame).toContain('ls -la (12s) (+3 -1)');
  });

  it('indents a framed call under the answer text, header and body together', () => {
    const lines = linesOf(render(scene('tools-concise')));
    const header = lines.find((line) => line.includes('rg -n "expiresAt" src'))!;
    expect(header.startsWith('  ✓ ')).toBe(true);
    const failedBody = lines.find((line) => line.includes('FAIL src/auth.test.ts'))!;
    expect(failedBody.startsWith('  FAIL')).toBe(true);
  });

  it('keeps failure and refusal visible in mono, by glyph', () => {
    const frame = render(scene('tools-concise'), 80, 'mono');
    expect(frame).toContain('✓ rg -n "expiresAt" src');
    expect(frame).toContain('✗ pnpm test auth');
    expect(frame).toContain('✗ git push --force origin main');
    expect(frame).toContain('DENIED');
  });

  describe('spinner', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    const glyphOf = (frame: string | undefined): string =>
      stripVTControlCharacters(frame ?? '')
        .trim()
        .charAt(0);

    const inTheme = (node: ReactElement) => (
      <ThemeProvider theme={THEMES.mono}>
        <SkinProvider skin={zenSkin}>{node}</SkinProvider>
      </ThemeProvider>
    );

    it('animates a running call, and stops when the call settles', async () => {
      vi.useFakeTimers();
      const view = await renderInAct(inTheme(header({ status: 'running' })));
      const first = glyphOf(view.lastFrame());
      expect(BRAILLE_SPINNER).toContain(first);

      await advance(250);
      const later = glyphOf(view.lastFrame());
      expect(BRAILLE_SPINNER).toContain(later);
      expect(later).not.toBe(first);

      view.rerender(inTheme(header({ status: 'completed' })));
      await advance(0);
      expect(glyphOf(view.lastFrame())).toBe('✓');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('schedules no timer for a call that is not running', async () => {
      vi.useFakeTimers();
      await renderInAct(inTheme(header({ status: 'failed' })));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('tool group summary', () => {
  it('keeps a mostly-fine run calm and lists the failing call on its own line beneath', () => {
    const lines = linesOf(render(scene('tool-group'))).filter(Boolean);
    const partial = lines.findIndex((line) => line.includes('ran 1 shell command') && line.includes('Searched'));
    expect(lines[partial].trim().startsWith('✓')).toBe(true);
    expect(lines[partial + 1].trim()).toBe('✗ 1 failed: pnpm test');
  });

  it('marks a run that wholly failed with the failure glyph, and still names what failed', () => {
    const lines = linesOf(render(scene('tool-group'))).filter(Boolean);
    const failedRun = lines.findIndex((line) => line.trim() === '✗ Ran 1 shell command');
    expect(failedRun).toBeGreaterThan(-1);
    expect(lines[failedRun + 1].trim()).toBe('✗ 1 failed: pnpm test');
  });
});

describe('working indicator', () => {
  const Indicator = zenSkin.WorkingIndicator;
  const view = (overrides: Partial<WorkingIndicatorView> = {}): WorkingIndicatorView => ({
    phase: 'thinking',
    elapsedSeconds: 0,
    tokensPerSecond: undefined,
    toolName: undefined,
    argumentChars: undefined,
    dotCount: 1,
    ...overrides,
  });

  it.each([
    [{ phase: 'thinking' }, 'thinking'],
    [{ phase: 'generating' }, 'writing'],
    [{ phase: 'processing' }, 'working'],
    [{ phase: 'tool_call', toolName: 'apply_patch' }, 'using apply_patch'],
  ] as const)('names what is happening (%o)', (overrides, label) => {
    expect(render(<Indicator {...view(overrides)} />)).toContain(`◆ ${label}`);
  });

  it('stays calm through a short wait and counts seconds only once it is long', () => {
    expect(render(<Indicator {...view({ elapsedSeconds: 9 })} />)).not.toMatch(/\d+s/);
    expect(render(<Indicator {...view({ elapsedSeconds: 10 })} />)).toContain('10s');
  });

  it('says which tool is being written when the container is streaming a call', () => {
    expect(render(scene('live-tool-call'))).toContain('using apply_patch');
  });

  describe('breathing', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('moves its dots while it is shown and leaves no timer behind when it goes', async () => {
      vi.useFakeTimers();
      const tree = (
        <ThemeProvider theme={THEMES.mono}>
          <SkinProvider skin={zenSkin}>
            <Indicator {...view()} />
          </SkinProvider>
        </ThemeProvider>
      );
      const result = await renderInAct(tree);
      const first = stripVTControlCharacters(result.lastFrame() ?? '');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(stripVTControlCharacters(result.lastFrame() ?? '')).not.toBe(first);

      // Taken off screen (the turn ended), it must stop ticking.
      result.rerender(
        <ThemeProvider theme={THEMES.mono}>
          <Text>done</Text>
        </ThemeProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('live region', () => {
  it('draws no divider rule, only the input and what hangs off it', () => {
    const frame = render(scene('live-idle'), 80);
    expect(frame).not.toMatch(/[─━]{4}/);
    expect(frame).toContain('›');
  });

  it('keeps every hint, joined by a dot', () => {
    const Hints = zenSkin.Hints;
    const frame = render(
      <Hints
        hints={[
          ['⏎', 'steer'],
          ['Alt+⏎', 'queue'],
          ['Esc', 'interrupt'],
        ]}
      />,
      80,
    );
    expect(frame.trim()).toBe('⏎ steer · Alt+⏎ queue · Esc interrupt');
  });
});

describe('approvals', () => {
  it('marks the riskiest class by shape: a triangle and a heavy rule, which a caution does not have', () => {
    const danger = render(scene('approval-danger'), 80, 'mono');
    const caution = render(scene('approval-shell'), 80, 'mono');
    expect(danger).toContain('▲');
    expect(danger).toContain('┃');
    expect(caution).not.toContain('▲');
    expect(caution).not.toContain('┃');
  });

  it('draws a caution without a box or a rail', () => {
    expect(render(scene('approval-shell'), 80, 'mono')).not.toMatch(/[│┃┌┐└┘╭╮╰╯]/);
  });

  it('puts the sentence first, then the thing being approved, then the question', () => {
    const lines = linesOf(render(scene('approval-shell'), 100)).filter(Boolean);
    const order = ['wants to run: shell', 'git push --force-with-lease', 'Allow this action?', 'Allow once'].map(
      (needle) => lines.findIndex((line) => line.includes(needle)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps a blocked path directly under its heading', () => {
    const lines = linesOf(render(scene('approval-denied-read'), 80)).filter(Boolean);
    expect(lines[0]).toContain('▲ Sandbox blocked read access:');
    expect(lines[1]).toContain('/etc/hosts');
  });

  describe('choices', () => {
    const Choices = zenSkin.ApprovalChoices;
    const options: ApprovalChoicesProps['options'] = [
      { label: 'Allow once', tone: 'success' },
      { label: 'Deny', tone: 'danger' },
    ];
    const choices = (overrides: Partial<ApprovalChoicesProps> = {}) => (
      <Choices
        question="Allow this action?"
        options={options}
        selectedIndex={0}
        layout="two-pane"
        description={{ title: 'Allow once', text: 'Allow this tool call.' }}
        {...overrides}
      />
    );

    it('asks as a sentence, then lays the options on one line with their number keys', () => {
      const lines = linesOf(render(choices(), 80));
      expect(lines[0]).toBe('Allow this action?');
      expect(lines[1]).toBe('› 1 Allow once  ·  2 Deny');
    });

    it('moves the selection marker with the selection', () => {
      expect(linesOf(render(choices({ selectedIndex: 1 }), 80))[1]).toBe('1 Allow once  ·  › 2 Deny');
    });

    it('explains only the selected option, on one dim line beneath', () => {
      const lines = linesOf(render(choices(), 80));
      expect(lines[2].trim()).toBe('Allow this tool call.');
      expect(lines).toHaveLength(3);
    });

    it('shows no explanation when there is none, rather than a placeholder', () => {
      expect(linesOf(render(choices({ description: { title: 'Allow once', text: undefined } }), 80))).toHaveLength(2);
    });

    it('is a plain vertical list in the list layout, with no question or explanation', () => {
      const lines = linesOf(render(choices({ layout: 'list', question: undefined, description: undefined }), 80));
      expect(lines).toEqual(['› 1 Allow once', '  2 Deny']);
    });

    const longOptions: ApprovalChoicesProps['options'] = [
      { label: 'Allow this command', tone: 'success' },
      { label: 'Deny', tone: 'danger' },
      { label: 'Allow for this session', tone: 'success' },
      { label: 'Always allow for this project', tone: 'success' },
    ];

    it('falls back to a list when the options do not fit on one line, and keeps all of them', () => {
      const lines = linesOf(render(choices({ options: longOptions, description: undefined }), 60));
      for (const [index, option] of longOptions.entries()) {
        expect(lines.some((line) => line.includes(`${index + 1} ${option.label}`))).toBe(true);
      }
      expect(lines.filter((line) => /\d (Allow|Always|Deny)/.test(line))).toHaveLength(4);
    });

    it('uses one line again once there is room for the same options', () => {
      const lines = linesOf(render(choices({ options: longOptions, description: undefined }), 120));
      expect(lines.filter((line) => /\d (Allow|Always|Deny)/.test(line))).toHaveLength(1);
    });

    it.each([40, 60])('never overflows %i columns, even with long labels', (columns) => {
      expect(widest(render(choices({ options: longOptions }), columns))).toBeLessThanOrEqual(columns);
    });
  });
});

describe('status line', () => {
  it('is one right-aligned line when nothing needs attention', () => {
    const lines = linesOf(statusAt(10, 100)).filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('10% ctx');
    // One column of padding keeps it off the very edge.
    expect(Array.from(lines[0]).length).toBe(99);
    expect(lines[0].startsWith(' ')).toBe(true);
  });

  it('leads with the safety label, then the model', () => {
    const line = linesOf(statusAt(10, 100)).filter(Boolean)[0];
    expect(line.indexOf('Sandboxed')).toBeGreaterThanOrEqual(0);
    expect(line.indexOf('Sandboxed')).toBeLessThan(line.indexOf('gpt-5.6-luna'));
  });

  it('shows the context as a percentage', () => {
    expect(statusAt(57)).toContain('57% ctx');
  });

  it('stays quiet below 75% and only warns from 75%', () => {
    expect(statusAt(74)).not.toContain('/compact');
    expect(statusAt(75)).toContain('75% ctx — consider /compact');
  });

  it('escalates at 90% with a marker and a firmer instruction', () => {
    const frame = statusAt(90);
    expect(frame).toContain('▲ 90% ctx — run /compact');
    expect(frame).not.toContain('consider');
  });

  it('keeps a warning context on screen, on its own row, when the terminal is too narrow for everything', () => {
    const frame = statusAt(92, 40);
    expect(frame).toContain('Sandboxed');
    expect(frame).toContain('92% ctx');
    expect(widest(frame)).toBeLessThanOrEqual(40);
  });

  it('sheds the advice before the percentage when width runs short', () => {
    const frame = statusAt(80, 60);
    expect(frame).toContain('80% ctx');
    expect(frame).not.toContain('/compact');
  });

  it.each([40, 60, 100])('always shows an alert as its own line at %i columns', (columns) => {
    const frame = render(scene('status-alerts'), columns);
    const lines = linesOf(frame);
    expect(lines.some((line) => line.includes('cache miss risk'))).toBe(true);
    expect(lines.some((line) => line.includes('Possible stall'))).toBe(true);
    expect(lines.filter((line) => line.includes('cache miss risk') && line.includes('Possible stall'))).toHaveLength(0);
  });

  it('marks an alert with a triangle even when the container did not, so it reads without colour', () => {
    const line = linesOf(render(scene('status-alerts'), 80)).find((candidate) => candidate.includes('Possible stall'))!;
    expect(line).toContain('▲');
  });

  const quota = (usedPercent: number) =>
    statusNode({
      lastCodexRateLimit: {
        allowed: true,
        limit_reached: false,
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          reset_after_seconds: 10_800,
          reset_at: 4_102_444_800,
        },
      } as never,
    });

  it('says nothing about quota until a window is above 75%', () => {
    expect(render(quota(42), 100)).not.toContain('5H');
    expect(render(quota(75), 100)).not.toContain('5H');
    expect(render(quota(78), 100)).toContain('5H 78%');
  });

  it('leaves out the tokens, speed and cache figures the container offers', () => {
    const frame = render(
      statusNode({
        lastUsage: {
          prompt_tokens: promptTokensFor(20),
          completion_tokens: 1_250,
          cache_read_tokens: 20_000,
          tokens_per_second: 48.2,
        } as never,
      }),
      100,
    );
    expect(frame).not.toMatch(/↑|↓|cached|t\/s/);
  });

  it('keeps a queue count, because it is something waiting on the person', () => {
    expect(render(statusNode({ queueLength: 3 }), 100)).toContain('[Q:3]');
  });

  it('keeps the safety label for an unsandboxed run, in whatever words the container chose', () => {
    const frame = render(
      <StatusBar settingsService={settings({ 'sandbox.enabled': false, 'shell.autoApproveMode': 'off' })} />,
      100,
    );
    expect(frame).toContain('gpt-5.6-luna');
    expect(frame).not.toContain('Sandboxed');
  });

  it('puts the line on the right edge of the terminal at every width', () => {
    for (const columns of [60, 80, 120]) {
      const [line] = linesOf(statusAt(10, columns)).filter(Boolean);
      expect(Array.from(line).length).toBe(columns - 1);
    }
  });
});

describe('whole skin', () => {
  it('leaves nothing of the live region to chance in mono: every scene still renders content', () => {
    for (const candidate of SCENES) {
      expect(render(candidate, 60, 'mono').trim().length, candidate.id).toBeGreaterThan(0);
    }
  });

  it('is a box-free page: no scene draws the corners of a frame around conversation or approvals', () => {
    for (const id of ['user-message', 'tools-concise', 'tool-group', 'approval-shell', 'approval-patch', 'status']) {
      expect(render(scene(id), 100, 'mono'), id).not.toMatch(/[┌┐└┘╭╮╰╯]/);
    }
  });

  it('adds an indent to a tool frame and nothing else, so it composes with the container own spacing', () => {
    const Frame = zenSkin.ToolFrame;
    const frame = render(
      <Frame status="completed" display="concise" toolName="shell">
        <Box>
          <ChatMessage msg={{ id: 'x', sender: 'system', text: 'body' }} />
        </Box>
      </Frame>,
    );
    expect(linesOf(frame)).toEqual(['  body']);
  });
});
