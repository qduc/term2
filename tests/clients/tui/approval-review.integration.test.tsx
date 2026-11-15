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
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    screen.rerender(<ApprovalHost {...props} request={root} />);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Approval review stopped'));
    expect(review).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    screen.rerender(<ApprovalHost {...props} request={root} />);
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(3));
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

it('hides immediately on automatic approval and recovers for manual input if sending fails', async () => {
  let resolveSend!: (value: { ok: boolean; kind?: string; code?: string; message?: string }) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    )
    .mockResolvedValueOnce({ ok: true, kind: 'accepted' });
  const review = vi.fn().mockResolvedValue({
    kind: 'reviewed',
    approved: true,
    advisory: {
      reasoning: 'Looks safe.',
      model: 'review-model',
      approved: true,
      riskLevel: 'low',
      confidence: 'high',
    },
  });
  const setNotice = vi.fn();
  const inputHandler = { current: null as InteractionInputHandler | null };
  const request = {
    interaction: {
      id: 'auto-req',
      kind: 'approval' as const,
      title: 'shell',
      turnId: 'turn',
      choices: [],
      toolName: 'shell',
      input: { command: 'echo ok', sandbox: 'unsandboxed' },
    },
    owner: 'turn' as const,
    agentName: 'Agent',
    backgroundCount: 0,
  };
  let answeredId: string | null = null;
  const renderHost = () => (
    <ApprovalHost
      request={answeredId === request.interaction.id ? undefined : request}
      connection={{ sessionId: 'session', send } as unknown as TuiConnection}
      inputHandler={inputHandler}
      interrupt={{ current: null }}
      activeTurnId="turn"
      reviewApproval={review}
      cancelInput={async () => ''}
      setNotice={setNotice}
      onStopped={() => {}}
      hide={(id) => {
        answeredId = id;
        screen.rerender(renderHost());
      }}
      editorValue=""
      changeInput={() => {}}
      replaceInput={() => {}}
    />
  );
  const screen = render(renderHost());
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(answeredId).toBe('auto-req');
    expect(screen.lastFrame()).not.toContain('Allow this action?');

    resolveSend({ ok: false, code: 'busy', message: 'Session busy' });
    await vi.waitFor(() => expect(setNotice).toHaveBeenCalledWith('Session busy'));
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain('Automatic approval not granted; manual approval required.'),
    );
    expect(review).toHaveBeenCalledTimes(1);

    inputHandler.current?.('y', {} as Parameters<InteractionInputHandler>[1]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  } finally {
    screen.unmount();
  }
});

it('defers the approval menu while review is pending, ignores focus events, and reveals it on Esc', async () => {
  const review = vi.fn(
    (_session: string, _request: string, _signal: AbortSignal) =>
      new Promise<import('../../../src/shared/contracts/approval-review.js').ApprovalReviewResult>(() => {}),
  );
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const inputHandler = { current: null as InteractionInputHandler | null };
  const screen = render(
    <ApprovalHost
      request={{
        interaction: {
          id: 'pending-review',
          kind: 'approval',
          title: 'shell',
          turnId: 'turn',
          choices: [],
          toolName: 'shell',
          input: { command: 'printf hello', sandbox: 'unsandboxed' },
        },
        owner: 'turn',
        agentName: 'Agent',
        backgroundCount: 0,
      }}
      connection={connection}
      inputHandler={inputHandler}
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
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(screen.lastFrame()).toContain('Reviewing shell for automatic approval');
    expect(screen.lastFrame()).not.toContain('Allow this action?');

    inputHandler.current?.('[O', {} as Parameters<InteractionInputHandler>[1]);
    inputHandler.current?.('[I', {} as Parameters<InteractionInputHandler>[1]);
    expect(review.mock.calls[0]![2].aborted).toBe(false);
    expect(screen.lastFrame()).toContain('Reviewing shell for automatic approval');

    inputHandler.current?.('', { escape: true } as Parameters<InteractionInputHandler>[1]);
    expect(review.mock.calls[0]![2].aborted).toBe(true);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Approval review stopped; manual approval required.'));
    expect(screen.lastFrame()).toContain('Allow this action?');
  } finally {
    screen.unmount();
  }
});

it('calls onManualApprovalNeeded only when an approval requires manual input', async () => {
  const onManualApprovalNeeded = vi.fn();
  const autoReview = vi.fn().mockResolvedValue({
    kind: 'reviewed',
    approved: true,
    advisory: { reasoning: 'Safe', model: 'review-model', approved: true, riskLevel: 'low', confidence: 'high' },
  });
  const connection = {
    sessionId: 'session',
    send: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as TuiConnection;
  const props = {
    connection,
    inputHandler: { current: null },
    interrupt: { current: null },
    activeTurnId: 'turn',
    cancelInput: async () => '',
    setNotice: () => {},
    onStopped: () => {},
    hide: () => {},
    editorValue: '',
    changeInput: () => {},
    replaceInput: () => {},
    onManualApprovalNeeded,
  };
  const autoScreen = render(
    <ApprovalHost
      {...props}
      reviewApproval={autoReview}
      request={{
        interaction: {
          id: 'auto-req',
          kind: 'approval',
          title: 'shell',
          turnId: 'turn',
          choices: [],
          toolName: 'shell',
          input: { command: 'ls', sandbox: 'unsandboxed' },
        },
        owner: 'turn',
        agentName: 'Agent',
        backgroundCount: 0,
      }}
    />,
  );
  try {
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledTimes(1));
    expect(onManualApprovalNeeded).not.toHaveBeenCalled();
  } finally {
    autoScreen.unmount();
  }

  const manualReview = vi.fn().mockResolvedValue({
    kind: 'reviewed',
    approved: false,
    advisory: { reasoning: 'Risky', model: 'review-model', approved: false, riskLevel: 'high', confidence: 'high' },
  });
  const manualScreen = render(
    <ApprovalHost
      {...props}
      reviewApproval={manualReview}
      request={{
        interaction: {
          id: 'manual-req',
          kind: 'approval',
          title: 'shell',
          turnId: 'turn',
          choices: [],
          toolName: 'shell',
          input: { command: 'rm -rf foo', sandbox: 'unsandboxed' },
        },
        owner: 'turn',
        agentName: 'Agent',
        backgroundCount: 0,
      }}
    />,
  );
  try {
    await vi.waitFor(() => expect(onManualApprovalNeeded).toHaveBeenCalledWith('manual-req'));
  } finally {
    manualScreen.unmount();
  }
});
