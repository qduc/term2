import React from 'react';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { ApprovalHost } from '../../../src/clients/tui/approval-host.js';
import type { TuiConnection } from '../../../src/clients/tui/integration.js';
import type { InteractionInputHandler } from '../../../src/clients/tui/interaction-input.js';

// The session reviews an approval before opening it (src/session/approval/approval-arbiter.ts).
// The TUI only renders that state: it never starts a review or answers on the reviewer's behalf.

type Key = Parameters<InteractionInputHandler>[1];

const props = (connection: TuiConnection, inputHandler: { current: InteractionInputHandler | null }) => ({
  connection,
  inputHandler,
  interrupt: { current: null as (() => boolean) | null },
  activeTurnId: 'turn',
  cancelInput: async () => '',
  setNotice: () => {},
  onStopped: () => {},
  hide: () => {},
  editorValue: '',
  changeInput: () => {},
  replaceInput: () => {},
});

const reviewing = [{ requestId: 'req', toolName: 'shell', summary: 'shell (this call only)', turnId: 'turn' }];

const request = (review?: object) => ({
  interaction: {
    id: 'req',
    kind: 'approval' as const,
    title: 'shell',
    turnId: 'turn',
    choices: [],
    toolName: 'shell',
    input: { command: 'printf hello', sandbox: 'unsandboxed' },
    ...(review ? { review: review as never } : {}),
  },
  owner: 'turn' as const,
  agentName: 'Agent',
  backgroundCount: 0,
});

it('shows a session review without options, ignores focus events, and takes it over on Esc', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const connection = { sessionId: 'session', send } as unknown as TuiConnection;
  const inputHandler = { current: null as InteractionInputHandler | null };
  const screen = render(
    <ApprovalHost {...props(connection, inputHandler)} request={undefined} reviewing={reviewing} />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Reviewing shell for automatic approval'));
    expect(screen.lastFrame()).not.toContain('Allow this action?');
    await vi.waitFor(() => expect(inputHandler.current).not.toBeNull());
    inputHandler.current?.('[O', {} as Key);
    inputHandler.current?.('[I', {} as Key);
    inputHandler.current?.('x', {} as Key);
    expect(send).not.toHaveBeenCalled();
    inputHandler.current?.('', { escape: true } as Key);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'take_over_review', requestId: 'req' }));
    inputHandler.current?.('', { escape: true } as Key);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    screen.unmount();
  }
});

it('denies during a review on n, atomically in the session, with the text typed after it as the reason', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const connection = { sessionId: 'session', send } as unknown as TuiConnection;
  const inputHandler = { current: null as InteractionInputHandler | null };
  const replaceInput = vi.fn();
  const base = { ...props(connection, inputHandler), replaceInput };
  const screen = render(<ApprovalHost {...base} request={undefined} reviewing={reviewing} />);
  try {
    await vi.waitFor(() => expect(inputHandler.current).not.toBeNull());
    inputHandler.current?.('n not now', {} as Key);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'answer',
        requestId: 'req',
        decision: { kind: 'deny', reason: 'not now' },
        provenance: { source: 'user' },
      }),
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'take_over_review' }));
    expect(replaceInput).toHaveBeenCalledWith('');
  } finally {
    screen.unmount();
  }
});

it('renders the recorded review when a person must decide', async () => {
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const screen = render(
    <ApprovalHost
      {...props(connection, { current: null })}
      request={request({
        kind: 'reviewed',
        approved: false,
        advisory: {
          approved: false,
          reasoning: 'Reads a credential file',
          model: 'review',
          source: 'llm',
          riskLevel: 'high',
          authorization: 'weak',
          confidence: 'high',
        },
      })}
    />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Reads a credential file'));
    expect(screen.lastFrame()).toContain('Automatic approval not granted; manual approval required.');
    expect(screen.lastFrame()).toContain('Allow this action?');
  } finally {
    screen.unmount();
  }
});

it('displays a child advisory and ignores malformed optional metadata', async () => {
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const screen = render(
    <ApprovalHost
      {...props(connection, { current: null })}
      request={{
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
      }}
    />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Child review explanation'));
    expect(screen.lastFrame()).not.toContain('Not reviewed automatically');
  } finally {
    screen.unmount();
  }
});

it('says the review is advisory when the advisory mode reviewed the request', async () => {
  const connection = { sessionId: 'session', send: vi.fn() } as unknown as TuiConnection;
  const screen = render(
    <ApprovalHost
      {...props(connection, { current: null })}
      request={request({
        kind: 'reviewed',
        approved: false,
        advisoryOnly: true,
        advisory: { approved: true, reasoning: 'Looks routine', model: 'review', source: 'llm' },
      })}
    />,
  );
  try {
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Looks routine'));
    expect(screen.lastFrame()).toContain('AI review is advisory; manual approval required.');
    expect(screen.lastFrame()).not.toContain('Automatic approval not granted');
  } finally {
    screen.unmount();
  }
});

it('denies without a reason on an empty Enter in the reason box', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const connection = { sessionId: 'session', send } as unknown as TuiConnection;
  const inputHandler = { current: null as InteractionInputHandler | null };
  const screen = render(<ApprovalHost {...props(connection, inputHandler)} request={request()} />);
  try {
    await vi.waitFor(() => expect(inputHandler.current).not.toBeNull());
    inputHandler.current?.('n', {} as Key);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Esc to cancel'));
    screen.stdin.write('\r');
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'answer',
        requestId: 'req',
        decision: { kind: 'deny' },
        provenance: { source: 'user' },
      }),
    );
  } finally {
    screen.unmount();
  }
});
