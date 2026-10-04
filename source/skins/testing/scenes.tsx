import React, { type ReactElement } from 'react';
import { Box, renderToString } from 'ink';
import Banner from '../../components/layout/Banner.js';
import BottomArea, { type BottomAreaProps } from '../../components/layout/BottomArea.js';
import StatusBar from '../../components/layout/StatusBar.js';
import ChatMessage from '../../components/message/ChatMessage.js';
import CommandGroupSummary from '../../components/message/CommandGroupSummary.js';
import CommandMessage from '../../components/message/CommandMessage.js';
import BackgroundTasksPanel from '../../components/layout/BackgroundTasksPanel.js';
import ConfirmPrompt from '../../components/prompt/ConfirmPrompt.js';
import QueuePausedPrompt from '../../components/prompt/QueuePausedPrompt.js';
import FirstRunSetupPrompt from '../../components/input/FirstRunSetupPrompt.js';
import SubagentActivityMessage from '../../components/message/SubagentActivityMessage.js';
import SkillSelectionMenu from '../../components/menu/SkillSelectionMenu.js';
import SlashCommandMenu from '../../components/menu/SlashCommandMenu.js';
import ResumeSelectionMenu from '../../components/menu/ResumeSelectionMenu.js';
import ApprovalPrompt from '../../components/prompt/ApprovalPrompt.js';
import { InputProvider } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { THEMES, type ThemeName } from '../../theme/palettes.js';
import { ThemeProvider } from '../../theme/ThemeContext.js';
import { getSkin } from '../registry.js';
import type { SkinName } from '../names.js';
import { SkinProvider } from '../SkinContext.js';
import type { Skin } from '../types.js';

/**
 * One fixed body of content that every skin is rendered against, by the
 * conformance suite and by `scripts/ui-snapshots.tsx` alike, so skins are compared
 * on identical data. Each scene drives the *real* containers, not copies, which is
 * what makes a passing scene mean something.
 *
 * `mustContain` is content the container hands the skin: a skin may restyle or
 * reorder it, never drop it.
 */
export interface Scene {
  id: string;
  /** What this scene exercises, for a human reading a failure. */
  description: string;
  node: () => ReactElement;
  mustContain: readonly string[];
  /**
   * Below this width a scene is only held to "fits and does not crash": a bar
   * that must drop segments to fit cannot be expected to keep its content too.
   */
  contentFromColumns?: number;
}

const settings = () =>
  createMockSettingsService({
    'agent.modelSelection': { model: 'gpt-5.6-luna', provider: 'codex' },
    'agent.reasoningEffort': 'high',
    'shell.autoApproveMode': 'auto',
    'sandbox.enabled': true,
  });

const SHELL_OK = {
  id: 'ok',
  sender: 'command',
  status: 'completed',
  command: 'rg -n "expiresAt" src',
  output: 'src/auth.ts:42:  if (token.expiresAt < Date.now())\nsrc/retry.ts:10:  // TODO: refresh',
  success: true,
  toolName: 'shell',
  toolArgs: { command: 'rg -n "expiresAt" src' },
} as const;

const SHELL_FAILED = {
  id: 'failed',
  sender: 'command',
  status: 'failed',
  command: 'pnpm test auth',
  output: 'FAIL src/auth.test.ts\n  ✗ refreshes near expiry\n    expected true, got false',
  success: false,
  toolName: 'shell',
  toolArgs: { command: 'pnpm test auth' },
} as const;

const SHELL_RUNNING = {
  id: 'running',
  sender: 'command',
  status: 'running',
  command: 'pnpm build',
  output: '',
  toolName: 'shell',
  toolArgs: { command: 'pnpm build' },
} as const;

const SHELL_REJECTED = {
  id: 'rejected',
  sender: 'command',
  status: 'completed',
  command: 'git push --force origin main',
  output: 'Tool execution was not approved.',
  success: false,
  isApprovalRejection: true,
  toolName: 'shell',
  toolArgs: { command: 'git push --force origin main' },
} as const;

const PATCH = {
  agentName: 'Agent',
  toolName: 'search_replace',
  argumentsText: JSON.stringify({
    path: 'src/auth.ts',
    replacements: [
      {
        search_content: 'if (token.expiresAt < Date.now()) {\n  return refresh(token);\n}',
        replace_content: 'if (token.expiresAt - Date.now() < SKEW_MS) {\n  return refresh(token);\n}',
      },
    ],
  }),
  rawInterruption: { type: 'tool_approval_item' },
};

const RISKY_COMMAND =
  'git push --force-with-lease origin feature/auth-refresh && pnpm publish --access public --tag next';

const SHELL_APPROVAL = {
  agentName: 'Agent',
  toolName: 'shell',
  argumentsText: JSON.stringify({ command: RISKY_COMMAND, cwd: '/home/user/term2', timeout_ms: 120_000 }),
  rawInterruption: { type: 'tool_approval_item' },
};

const DOCKER_APPROVAL = {
  agentName: 'Agent',
  toolName: 'shell',
  argumentsText: JSON.stringify({ command: 'docker run --privileged -v /:/host alpine sh' }),
  rawInterruption: { type: 'tool_approval_item' },
  dockerHostControl: true,
};

const DENIED_READ_APPROVAL = {
  agentName: 'Agent',
  toolName: 'shell',
  argumentsText: JSON.stringify({ command: 'cat /etc/hosts' }),
  rawInterruption: { type: 'tool_approval_item' },
  deniedRead: {
    deniedPath: '/etc/hosts',
    suggestedParent: '/etc',
    sensitive: false,
  },
};

const MARKDOWN = `## Findings

Two problems in the **auth middleware**:

1. Tokens are never refreshed when \`expiresAt\` is inside the skew window
2. The retry helper swallows \`401\` responses

\`\`\`ts
export function isExpired(t: Token, skewMs = 30_000) {
  return t.expiresAt - Date.now() < skewMs;
}
\`\`\`
`;

const ASK_USER_APPROVAL = {
  agentName: 'Agent',
  toolName: 'ask_user',
  argumentsText: JSON.stringify({
    questions: [
      {
        question: 'Which refresh strategy should I use?',
        options: [
          { label: 'Refresh inside the skew window', description: 'Recommended: avoids the one-hour logout.' },
          { label: 'Refresh on every request', description: 'Simpler, but doubles token traffic.' },
        ],
      },
      { question: 'Add a regression test?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  }),
  rawInterruption: { type: 'ask_user' },
};

const toolBody = (id: string, toolName: string, output: string, toolArgs: Record<string, unknown>) =>
  ({
    id,
    sender: 'command',
    status: 'completed',
    command: `${toolName} ${JSON.stringify(toolArgs)}`,
    output,
    success: true,
    toolName,
    toolArgs,
  } as const);

const GREP_BODY = toolBody(
  'grep',
  'grep',
  'src/auth.ts:42:  if (token.expiresAt < Date.now())\nsrc/auth.ts:57:  return token.expiresAt\nsrc/retry.ts:10:  // TODO: refresh',
  { pattern: 'expiresAt' },
);
const READ_BODY = toolBody(
  'read',
  'read_file',
  'File: src/auth.ts (120 lines) [lines 40-43]\n===\n40: export function isExpired(t: Token) {\n41:   return expired(t);\n42: }\n43: ',
  { path: 'src/auth.ts' },
);
const WEB_SEARCH_BODY = toolBody(
  'web',
  'web_search',
  '## Answer\nRefresh tokens before they expire, using a skew window.\n\n## Search Results\n### 1. Token refresh patterns\n**URL:** https://example.com/refresh\n**Published:** 2025-01-02\nA skew window avoids edge expiry.\n---',
  { query: 'token refresh skew' },
);
const WEB_FETCH_BODY = toolBody(
  'fetch',
  'web_fetch',
  'Title: Token refresh patterns\nURL: https://example.com/refresh\n\nA skew window avoids edge expiry.',
  { url: 'https://example.com/refresh' },
);

const SKILLS = [
  { name: 'tdd', description: 'Test-driven development loop.', isProjectLevel: true },
  { name: 'release', description: 'Cut a release.', isProjectLevel: false },
];

const ADVISED_APPROVAL = {
  ...SHELL_APPROVAL,
  llmAdvisory: {
    source: 'model',
    approved: false,
    model: 'gpt-5.6-luna',
    reasoning: 'Force pushing rewrites shared history.',
  },
};

const noop = () => {};

const bottomAreaProps = (overrides: Partial<BottomAreaProps>): BottomAreaProps => ({
  pendingApproval: null,
  waitingForApproval: false,
  waitingForRejectionReason: false,
  isProcessing: false,
  onSubmit: async () => {},
  slashCommands: [{ name: '/clear', description: 'Clear screen', action: noop } as never],
  isShellMode: false,
  settingsService: settings(),
  loggingService: {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    setCorrelationId: noop,
    clearCorrelationId: noop,
  } as never,
  historyService: { getMessages: () => [], addMessage: noop, clear: noop } as never,
  onApprove: noop,
  onReject: noop,
  queuePaused: false,
  queueLength: 0,
  onResumeQueue: noop,
  onDiscardQueue: noop,
  backgroundTaskManagerOpen: false,
  onBackgroundTaskManagerOpenChange: noop,
  lastUsage: { prompt_tokens: 229_000, completion_tokens: 1_250, cache_read_tokens: 120_000 } as never,
  costSummary: { state: 'estimated', knownUsdMicros: 123_456 } as never,
  ...overrides,
});

const approval = (value: unknown) => <ApprovalPrompt approval={value as never} onApprove={noop} onReject={noop} />;

export const SCENES: readonly Scene[] = [
  {
    id: 'banner',
    description: 'The session banner: version, mode badge, provider/model/effort.',
    node: () => <Banner settingsService={settings()} />,
    mustContain: ['term²', 'gpt-5.6-luna'],
  },
  {
    id: 'user-message',
    description: 'A user turn.',
    node: () => <ChatMessage msg={{ id: 'u', sender: 'user', text: 'why do users get logged out after an hour?' }} />,
    mustContain: ['why do users get logged out after an hour?'],
  },
  {
    id: 'assistant-answer',
    description: 'Markdown answer with a list and a code block, plus a reasoning note.',
    node: () => (
      <Box flexDirection="column">
        <ChatMessage msg={{ id: 'r', sender: 'reasoning', text: 'Checking the refresh path first.' }} maxWidth={36} />
        <ChatMessage msg={{ id: 'b', sender: 'bot', text: MARKDOWN }} maxWidth={36} />
      </Box>
    ),
    mustContain: ['Checking the refresh path first.', 'Findings', 'isExpired'],
  },
  {
    id: 'tools-standard',
    description: 'Tool calls in standard display: ok, failed, running, and an approval rejection.',
    node: () => (
      <Box flexDirection="column">
        <CommandMessage {...SHELL_OK} displayMode="standard" />
        <CommandMessage {...SHELL_FAILED} displayMode="standard" />
        <CommandMessage {...SHELL_RUNNING} displayMode="standard" />
        <CommandMessage {...SHELL_REJECTED} displayMode="standard" />
      </Box>
    ),
    // A running call is deliberately hidden until it has run for a moment, so it is not asserted.
    mustContain: ['rg -n "expiresAt" src', 'src/auth.ts:42', 'pnpm test auth', 'FAIL src/auth.test.ts', 'DENIED'],
  },
  {
    id: 'tools-concise',
    description: 'The same calls in concise display, the default.',
    node: () => (
      <Box flexDirection="column">
        <CommandMessage {...SHELL_OK} displayMode="concise" />
        <CommandMessage {...SHELL_FAILED} displayMode="concise" />
        <CommandMessage {...SHELL_RUNNING} displayMode="concise" />
        <CommandMessage {...SHELL_REJECTED} displayMode="concise" />
      </Box>
    ),
    mustContain: ['rg -n "expiresAt" src', 'pnpm test auth', 'DENIED'],
  },
  {
    id: 'tool-group',
    description: 'A grouped run of concise tool calls: all ok, partly failed, all failed.',
    node: () => {
      const members = [
        { id: '1', sender: 'command', toolName: 'grep', status: 'completed', success: true },
        { id: '2', sender: 'command', toolName: 'read_file', status: 'completed', success: true },
        { id: '3', sender: 'command', toolName: 'shell', command: 'pnpm test', status: 'failed', success: false },
      ];
      return (
        <Box flexDirection="column">
          <CommandGroupSummary members={members.slice(0, 2)} status="completed" />
          <CommandGroupSummary members={members} status="partial" />
          <CommandGroupSummary members={members.slice(2)} status="failed" />
        </Box>
      );
    },
    mustContain: ['Searched', 'read', 'failed'],
  },
  {
    id: 'approval-shell',
    description: 'A risky shell command awaiting approval, with the two-pane choices.',
    node: () => approval(SHELL_APPROVAL),
    mustContain: ['shell', 'git push --force-with-lease', 'pnpm publish', 'Allow once', 'Deny', 'Allow this action?'],
  },
  {
    id: 'approval-patch',
    description: 'A file edit awaiting approval, showing the diff.',
    node: () => approval(PATCH),
    mustContain: ['search_replace', 'src/auth.ts', 'SKEW_MS', 'Allow once', 'Deny'],
  },
  {
    id: 'approval-danger',
    description: 'Docker host control: the riskiest approval class, which must be recognisable by shape.',
    node: () => approval(DOCKER_APPROVAL),
    mustContain: ['Docker host control', 'docker run --privileged', 'Allow this command', 'Deny'],
  },
  {
    id: 'approval-denied-read',
    description: 'A sandbox-blocked read, with the list-only choices.',
    node: () => approval(DENIED_READ_APPROVAL),
    mustContain: ['Sandbox blocked read access', '/etc/hosts', 'Deny'],
  },
  {
    id: 'ask-user',
    description: 'The ask-user question: two questions, a recommended option, and the built-in custom-answer row.',
    node: () => approval(ASK_USER_APPROVAL),
    mustContain: [
      'Which refresh strategy should I use?',
      'Refresh inside the skew window',
      'Refresh on every request',
      'Recommended: avoids the one-hour logout.',
      'Esc cancel',
    ],
  },
  {
    id: 'subagent-feed',
    description: 'A subagent feed: running with its latest calls, completed with an answer, and failed.',
    node: () => (
      <Box flexDirection="column">
        <SubagentActivityMessage
          msg={{
            role: 'explorer',
            task: 'map auth flow',
            status: 'running',
            tools: ['read_file "src/auth.ts" (Success)', 'grep "expiresAt" (Failed)'],
          }}
        />
        <SubagentActivityMessage
          msg={{
            role: 'explorer',
            task: 'map auth flow',
            status: 'completed',
            finalText: 'Tokens refresh in src/auth.ts.',
          }}
        />
        <SubagentActivityMessage
          msg={{ role: 'reviewer', task: 'review the patch', status: 'failed', error: 'timeout', tools: [] }}
        />
      </Box>
    ),
    mustContain: ['map auth flow', 'src/auth.ts', 'Tokens refresh in src/auth.ts.', 'failed: timeout'],
  },
  {
    id: 'tool-bodies',
    description: 'The bodies of the specialised tool renderers: grep, read_file, web_search and web_fetch.',
    node: () => (
      <Box flexDirection="column">
        <CommandMessage {...GREP_BODY} displayMode="standard" />
        <CommandMessage {...READ_BODY} displayMode="standard" />
        <CommandMessage {...WEB_SEARCH_BODY} displayMode="standard" />
        <CommandMessage {...WEB_FETCH_BODY} displayMode="standard" />
      </Box>
    ),
    mustContain: [
      'src/retry.ts',
      'return expired(t);',
      'Answer Summary',
      'Token refresh patterns',
      'https://example.com/refresh',
    ],
  },
  {
    id: 'menus',
    description: 'Menu bodies: a list menu, a two-column menu, and a menu with nothing to show.',
    node: () => (
      <Box flexDirection="column">
        <SlashCommandMenu
          commands={[
            { name: 'clear', description: 'Clear screen', action: noop } as never,
            { name: 'settings', description: 'Open settings', action: noop } as never,
          ]}
          selectedIndex={1}
          filter=""
        />
        <SkillSelectionMenu items={SKILLS as never} selectedIndex={0} query="" />
        <ResumeSelectionMenu items={[]} selectedIndex={0} query="" />
      </Box>
    ),
    mustContain: ['Commands', 'settings', 'Skills', 'Test-driven development loop.', 'No saved conversations found'],
  },
  {
    id: 'approval-advisory',
    description: 'An approval carrying an AI advisor note.',
    node: () => approval(ADVISED_APPROVAL),
    mustContain: ['AI Advisor: CAUTION', 'Force pushing rewrites shared history.', 'Deny'],
  },
  {
    id: 'confirm-prompts',
    description: 'The confirmation surfaces: a yes/no confirm, the paused-queue notice, and first-run setup.',
    node: () => (
      <Box flexDirection="column">
        <ConfirmPrompt
          warning="Switching to plan mode requires clearing the current session."
          question="Clear session and switch to plan mode?"
          defaultIndex={1}
          onConfirm={noop}
          onDecline={noop}
          onCancel={noop}
        />
        <QueuePausedPrompt queueLength={2} pauseReason="failure" onResume={noop} onDiscard={noop} />
        <FirstRunSetupPrompt phase="provider" provider="openai" />
      </Box>
    ),
    mustContain: [
      'Clear session and switch to plan mode?',
      'Queue paused',
      'resume',
      'discard',
      'First-run setup',
      'Normal chat is disabled until setup completes.',
    ],
  },
  {
    id: 'task-panel',
    description: 'The background-task list above the input.',
    node: () => (
      <BackgroundTasksPanel
        now={66_000}
        tasks={[
          {
            kind: 'subagent',
            runId: 'run-1',
            role: 'explorer',
            task: 'map auth',
            status: 'running',
            startedAt: 1_000,
          },
          { kind: 'shell', jobId: 'shell-1', command: 'pnpm test', status: 'running', startedAt: 61_000 },
        ]}
      />
    ),
    mustContain: ['Tasks', 'active'],
  },
  {
    id: 'live-shell',
    description: 'The live region while a foreground shell command runs.',
    node: () => (
      <InputProvider>
        <BottomArea {...bottomAreaProps({ activeShellCommand: 'pnpm test auth' })} />
      </InputProvider>
    ),
    mustContain: ['pnpm test auth'],
  },
  {
    id: 'status',
    description: 'The status bar with usage, cache, context, cost and provider quota.',
    node: () => (
      <StatusBar
        settingsService={settings()}
        // The renderToString width below drives the real layout; this only has to be set.
        lastUsage={
          {
            prompt_tokens: 229_000,
            completion_tokens: 1_250,
            cache_read_tokens: 120_000,
            tokens_per_second: 48.2,
          } as never
        }
        costSummary={{ state: 'estimated', knownUsdMicros: 123_456 } as never}
        queueLength={2}
        lastCodexRateLimit={
          {
            allowed: true,
            limit_reached: false,
            primary: { used_percent: 42, window_minutes: 300, reset_after_seconds: 10_800, reset_at: 4_102_444_800 },
          } as never
        }
      />
    ),
    mustContain: ['gpt-5.6-luna', 'Sandboxed'],
    contentFromColumns: 60,
  },
  {
    id: 'status-alerts',
    description: 'The status bar when something needs attention: cache-miss risk and a run-budget notice.',
    node: () => (
      <StatusBar
        settingsService={settings()}
        lastUsage={{ prompt_tokens: 229_000, completion_tokens: 1_250 } as never}
        largeUncachedWarning={{ estimatedTokens: 230_000 }}
        runBudgetNotice={{ type: 'tool_stall', toolName: 'shell', count: 6 } as never}
      />
    ),
    mustContain: ['cache miss risk', 'Possible stall'],
    contentFromColumns: 60,
  },
  {
    id: 'live-working',
    description: 'The live region while the model is thinking: working line, input, hints, status.',
    node: () => (
      <InputProvider>
        <BottomArea {...bottomAreaProps({ isProcessing: true, thinkingStartedAt: Date.now() - 12_000 })} />
      </InputProvider>
    ),
    mustContain: ['steer', 'queue'],
  },
  {
    id: 'live-tool-call',
    description: 'The live region while a tool call is being streamed.',
    node: () => (
      <InputProvider>
        <BottomArea
          {...bottomAreaProps({
            isProcessing: true,
            toolCallStreamingInfo: { toolName: 'apply_patch', argumentCharCount: 1240 },
            liveStreamingSpeed: { tps: 48.2 },
          })}
        />
      </InputProvider>
    ),
    mustContain: ['apply_patch'],
  },
  {
    id: 'live-idle',
    description: 'The live region at rest: empty input and its hints.',
    node: () => (
      <InputProvider>
        <BottomArea {...bottomAreaProps({})} />
      </InputProvider>
    ),
    mustContain: ['commands'],
  },
];

export interface RenderSceneOptions {
  /** A registered skin's name, or a skin object (used while developing one, and by the meta-tests). */
  skin: SkinName | Skin;
  theme: ThemeName;
  columns: number;
}

/**
 * Renders a scene through the real containers, under the given skin and theme, at a
 * fixed width.
 *
 * `renderToString` lays out at `columns` but gives hooks no stdout width, so
 * `useTerminalColumns()` and `useStdout().stdout.columns` would fall back to a
 * default whatever width was asked for, and every width-adaptive choice a skin
 * makes (dropping a segment, stacking options, shortening a banner) would go
 * untested. The width is therefore set on `process.stdout` for the duration of the
 * render, exactly where a real terminal reports it, and restored afterwards.
 */
export function renderScene(scene: Scene, { skin, theme, columns }: RenderSceneOptions): string {
  const hadOwn = Object.prototype.hasOwnProperty.call(process.stdout, 'columns');
  const previous = process.stdout.columns;
  process.stdout.columns = columns;
  try {
    return renderToString(
      <ThemeProvider theme={THEMES[theme]}>
        <SkinProvider skin={typeof skin === 'string' ? getSkin(skin) : skin}>
          <Box flexDirection="column" width={columns}>
            {scene.node()}
          </Box>
        </SkinProvider>
      </ThemeProvider>,
      { columns },
    );
  } finally {
    if (hadOwn) {
      process.stdout.columns = previous;
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  }
}
