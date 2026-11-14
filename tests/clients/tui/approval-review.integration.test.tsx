import React from 'react';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { ApprovalHost } from '../../../src/clients/tui/approval-host.js';
import type { TuiConnection } from '../../../src/clients/tui/integration.js';
import type { InteractionInputHandler } from '../../../src/clients/tui/interaction-input.js';

it('does not restart a cancelled review when a background request replaces the root prompt', async () => {
  const inputHandler = { current: null as InteractionInputHandler | null };
  const interrupt = { current: null as (() => boolean) | null };
  const review = vi.fn(
    (_session: string, _request: string, _signal: AbortSignal) =>
      new Promise<import('../../../src/shared/contracts/approval-review.js').ApprovalReviewResult>(() => {}),
  );
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const root = {
    interaction: {
      id: 'root-request',
      kind: 'approval' as const,
      title: 'shell',
      turnId: 'turn',
      choices: [],
      toolName: 'shell',
      input: { command: 'printf hello', sandbox: 'unsandboxed' },
    },
    owner: 'turn' as const,
    agentName: 'Agent',
    backgroundCount: 0,
  };
  const background = {
    interaction: { ...root.interaction, id: 'background-request', taskId: 'task' },
    owner: 'background' as const,
    agentName: 'Background',
    backgroundCount: 1,
  };
  const props = {
    connection,
    inputHandler,
    interrupt,
    activeTurnId: 'turn',
    reviewApproval: review,
    cancelInput: async () => '',
    setNotice: () => {},
    onStopped: () => {},
    hide: () => {},
    editorValue: '',
    changeInput: () => {},
    replaceInput: () => {},
  };
  const screen = render(<ApprovalHost {...props} request={root} />);
  try {
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    const signal = review.mock.calls[0]![2];
    inputHandler.current?.('n', {} as Parameters<InteractionInputHandler>[1]);
    expect(signal.aborted).toBe(true);
    screen.rerender(<ApprovalHost {...props} request={background} />);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Background'));
    screen.rerender(<ApprovalHost {...props} request={root} />);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Approval review stopped'));
    expect(review).toHaveBeenCalledTimes(1);
  } finally {
    screen.unmount();
  }
});

it.each([
  { toolName: 'shell', input: 'git status -sb && gh run list --limit 5' },
  { toolName: 'read_file', input: 'example.txt' },
])('shows the review explanation for a foreground $toolName approval', async ({ toolName, input }) => {
  const review = vi.fn().mockResolvedValue({
    kind: 'reviewed',
    approved: false,
    advisory: {
      reasoning: 'The command looks safe.',
      model: 'review-model',
      approved: true,
      riskLevel: 'low',
      confidence: 'high',
    },
  });
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const screen = render(
    <ApprovalHost
      request={{
        interaction: {
          id: 'regular',
          kind: 'approval',
          title: toolName,
          turnId: 'turn',
          choices: [],
          toolName,
          input: { [toolName === 'shell' ? 'command' : 'path']: input },
        },
        owner: 'turn',
        agentName: 'Agent',
        backgroundCount: 0,
      }}
      connection={connection}
      inputHandler={{ current: null }}
      interrupt={{ current: null }}
      activeTurnId="turn"
      reviewApproval={review}
      cancelInput={async () => ''}
      setNotice={() => {}}
      onStopped={() => {}}
      hide={() => {}}
      editorValue=""
      changeInput={() => {}}
      replaceInput={() => {}}
    />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('The command looks safe.'));
    expect(screen.lastFrame()).toContain('AI Advisor: SAFE');
    expect(screen.lastFrame()).toContain('manual approval required');
    expect(connection.send).not.toHaveBeenCalled();
  } finally {
    screen.unmount();
  }
});

it('restarts an interrupted foreground review when a background prompt is dismissed', async () => {
  const review = vi.fn(
    (_session: string, _request: string, _signal: AbortSignal) =>
      new Promise<import('../../../src/shared/contracts/approval-review.js').ApprovalReviewResult>(() => {}),
  );
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const root = {
    interaction: {
      id: 'root',
      kind: 'approval' as const,
      title: 'shell',
      turnId: 'turn',
      choices: [],
      toolName: 'shell',
      input: { command: 'git status' },
    },
    owner: 'turn' as const,
    agentName: 'Agent',
    backgroundCount: 0,
  };
  const background = {
    interaction: { ...root.interaction, id: 'background', taskId: 'task' },
    owner: 'background' as const,
    agentName: 'Background',
    backgroundCount: 1,
  };
  const props = {
    connection,
    inputHandler: { current: null },
    interrupt: { current: null },
    activeTurnId: 'turn',
    reviewApproval: review,
    cancelInput: async () => '',
    setNotice: () => {},
    onStopped: () => {},
    hide: () => {},
    editorValue: '',
    changeInput: () => {},
    replaceInput: () => {},
  };
  const screen = render(<ApprovalHost {...props} request={root} />);
  try {
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    const firstSignal = review.mock.calls[0]![2];
    screen.rerender(<ApprovalHost {...props} request={background} />);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Not reviewed automatically'));
    expect(firstSignal.aborted).toBe(true);
    screen.rerender(<ApprovalHost {...props} request={root} />);
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    expect(connection.send).not.toHaveBeenCalled();
  } finally {
    screen.unmount();
  }
});

it('displays a child advisory and ignores malformed optional metadata', async () => {
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const request = {
    interaction: {
      id: 'child',
      turnId: 'turn',
      kind: 'approval' as const,
      title: 'read_file',
      taskId: 'task',
      choices: [],
      toolName: 'read_file',
      input: { path: 'file' },
      presentation: {
        llmAdvisory: {
          reasoning: 'Child review explanation',
          model: 'review',
          approved: false,
          riskLevel: { invalid: true },
        },
      },
    },
    owner: 'background' as const,
    agentName: 'Child',
    backgroundCount: 1,
  };
  const screen = render(
    <ApprovalHost
      request={request}
      connection={connection}
      inputHandler={{ current: null }}
      interrupt={{ current: null }}
      activeTurnId="turn"
      cancelInput={async () => ''}
      setNotice={() => {}}
      onStopped={() => {}}
      hide={() => {}}
      editorValue=""
      changeInput={() => {}}
      replaceInput={() => {}}
    />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Child review explanation'));
    expect(screen.lastFrame()).not.toContain('Not reviewed automatically');
  } finally {
    screen.unmount();
  }
});
