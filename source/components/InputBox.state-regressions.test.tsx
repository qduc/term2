// @ts-expect-error React act marker is not declared globally
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { expect, it, vi } from 'vitest';
import ApplicationInputSurface from './input/ApplicationInputSurface.js';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { MenuControllerImpl } from './input/menu-controller.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { renderInAct, rerenderInAct } from '../test-helpers/ink-testing.js';
import { formatUserTurnForDisplay, type UserTurn } from '../types/user-turn.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import { ConversationAdmissionWorkflow } from '../services/conversation/conversation-admission-workflow.js';
import { LargeUncachedInputGuard } from '../services/large-uncached-input-guard.js';

vi.mock('../services/file-service.js', () => ({
  getWorkspaceEntries: vi.fn(async () => [{ path: 'mock/path', type: 'file' }]),
  refreshWorkspaceEntries: vi.fn(async () => [{ path: 'mock/path', type: 'file' }]),
  getWorkspaceEntriesMeta: vi.fn(() => ({
    lastLoadedAt: null,
    totalEntries: 1,
    truncated: false,
    truncatedByTotalLimit: false,
    limit: 10_000,
  })),
}));

const loggingService = Object.fromEntries(
  ['info', 'warn', 'error', 'debug', 'security', 'setCorrelationId', 'getCorrelationId', 'clearCorrelationId'].map(
    (k) => [k, () => {}],
  ),
) as unknown as LoggingService;
const historyService = {
  getMessages: () => [],
  getTurns: () => [],
  addMessage: () => {},
  clear: () => {},
} as unknown as HistoryService;
const props = {
  slashCommands: [],
  settingsService: createMockSettingsService(),
  loggingService,
  historyService,
  onSubmit: () => {},
};
const write = async (stdin: { write: (s: string) => void }, input: string) => {
  await act(async () => {
    stdin.write(input);
    // Ink waits for a possible continuation before emitting a bare Escape.
    if (/^\x1b+$/.test(input)) await new Promise((resolve) => setTimeout(resolve, 60));
    for (let n = 0; n < 3; n++) await new Promise((resolve) => setImmediate(resolve));
  });
};

it('a queued edit remains addressed to its ID after path completion', async () => {
  const controller = new MenuControllerImpl();
  const edits = vi.fn(async () => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const submits = vi.fn();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        {...props}
        turnInFlight
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[
          { id: 'q-1', text: 'Inspect', turn: { text: 'Inspect' }, queuedAt: 1, delivery: 'follow_up' },
        ]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  expect(view.lastFrame()).toContain('edit queued');
  await write(view.stdin, ' @');
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('path');
  await write(view.stdin, '\r');
  expect(controller.getSnapshot().stack).toHaveLength(0);
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenCalledTimes(1);
  expect(submits).not.toHaveBeenCalled();
});

it('editing text preserves queued image and skill attachments', async () => {
  const original: UserTurn = {
    text: 'Inspect this',
    images: [{ id: 'image-1', data: 'fake-test-image', mimeType: 'image/png', byteSize: 15, displayNumber: 1 }],
    skill: { name: 'review', description: 'review code', body: 'Perform a review' },
  };
  const edits = vi.fn(async (_id: string, _turn: UserTurn) => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const view = await renderInAct(
    <InputProvider>
      <ApplicationInputSurface
        {...props}
        turnInFlight
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[
          { id: 'q-1', text: formatUserTurnForDisplay(original), turn: original, queuedAt: 1, delivery: 'follow_up' },
        ]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, ' carefully');
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenCalledTimes(1);
  expect(edits.mock.calls[0]?.[1].images).toEqual(original.images);
  expect(edits.mock.calls[0]?.[1].skill).toEqual(original.skill);
  expect(edits.mock.calls[0]?.[1].text).toBe('Inspect this carefully');
});

it('input history starts from latest after resubmitting a recalled turn', async () => {
  const turns = [{ text: 'first' }, { text: 'second' }];
  const controller = new MenuControllerImpl();
  const history = { ...historyService, getTurns: () => turns } as unknown as HistoryService;
  const onSubmit = (turn: UserTurn) => {
    turns.push(turn);
    controller.replaceText('');
  };
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface {...props} historyService={history} onSubmit={onSubmit} />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  expect(controller.getSnapshot().editor.text).toBe('second');
  await write(view.stdin, ' edited');
  await write(view.stdin, '\r');
  expect(turns.at(-1)?.text).toBe('second edited');
  await write(view.stdin, '\x1b[A');
  expect(controller.getSnapshot().editor.text).toBe('second edited');
});

it('bracketed paste in an open menu inserts content without framing bytes', async () => {
  const controller = new MenuControllerImpl();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface {...props} />
    </InputProvider>,
  );
  await write(view.stdin, '@');
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('path');
  await write(view.stdin, '\x1b[200~mock/path\x1b[201~');
  expect(controller.getSnapshot().editor.text).toBe('@mock/path');
});

it('idle Enter asks for large uncached request confirmation', async () => {
  const guard = new LargeUncachedInputGuard();
  guard.markResumedSession({ updatedAtMs: 0 });
  const now = 600_000;
  const preview = vi.fn(() =>
    guard.inspect({ now, estimatedBytes: 360_000, contentKey: 'old-session', provider: 'openai', model: 'test-model' }),
  );
  expect(preview().action).toBe('warn');
  preview.mockClear();
  const send = vi.fn(async () => {});
  const workflow = new ConversationAdmissionWorkflow({
    conversation: {
      isQueueActive: () => false,
      previewInputSurge: () => ({
        action: 'allow',
        stats: {
          messageCount: 1,
          totalSerializedBytes: 10,
          duplicateToolCallSignatures: 0,
          maxDuplicateToolCallSignatureCount: 0,
        },
      }),
      previewLargeUncachedInput: preview,
    },
    history: { addMessage: () => {} },
    logger: { debug: () => {} },
    send,
    now: () => now,
  });
  const view = await renderInAct(
    <InputProvider>
      <ApplicationInputSurface
        {...props}
        turnInFlight={false}
        onSubmit={(turn, options) => {
          workflow.submit(turn, options);
        }}
      />
    </InputProvider>,
  );
  await write(view.stdin, 'continue');
  await write(view.stdin, '\r');
  expect(workflow.getSnapshot()?.kind).toBe('large_uncached');
  expect(send).not.toHaveBeenCalled();
});

const attachedTurn: UserTurn = {
  text: 'Inspect',
  images: [{ id: 'queued-image', data: 'synthetic-image', mimeType: 'image/png', byteSize: 15, displayNumber: 1 }],
  skill: { name: 'review', description: 'review code', body: 'Perform a review' },
};
const queuedMessage = {
  id: 'q-1',
  text: formatUserTurnForDisplay(attachedTurn),
  turn: attachedTurn,
  queuedAt: 1,
  delivery: 'follow_up' as const,
};

it('a queued edit and its attachments survive modal preemption', async () => {
  const controller = new MenuControllerImpl();
  const edits = vi.fn(async (_id: string, _turn: UserTurn) => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const submits = vi.fn();
  const renderSurface = (enabled: boolean) => (
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        {...props}
        enabled={enabled}
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>
  );
  const view = await renderInAct(renderSurface(true));
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, ' carefully');
  await rerenderInAct(view, renderSurface(false));
  await write(view.stdin, 'ignored');
  expect(controller.getSnapshot().editor.text).toBe('Inspect carefully');
  await rerenderInAct(view, renderSurface(true));
  expect(view.lastFrame()).toContain('edit queued');
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenCalledExactlyOnceWith('q-1', { ...attachedTurn, text: 'Inspect carefully' });
  expect(submits).not.toHaveBeenCalled();
  expect(controller.getSnapshot().editor.text).toBe('');
});

it('cancel after path completion restores the prior draft images', async () => {
  let input!: ReturnType<typeof useInputContext>;
  const ObserveInput = () => {
    input = useInputContext();
    return null;
  };
  const edits = vi.fn();
  const view = await renderInAct(
    <InputProvider>
      <ObserveInput />
      <ApplicationInputSurface {...props} onEditQueuedMessage={edits} pendingQueuedMessages={[queuedMessage]} />
    </InputProvider>,
  );
  const draftImages = [{ ...attachedTurn.images![0]!, id: 'draft-image' }];
  await act(async () => input.setImages(draftImages));
  expect(input.images).toEqual(draftImages);
  await write(view.stdin, '\x1b[A');
  expect(input.images).toEqual(draftImages);
  await write(view.stdin, 'e');
  expect(input.images).toEqual(attachedTurn.images);
  expect(input.queueInput.editing?.restoreDraft.images).toEqual(draftImages);
  await write(view.stdin, ' @');
  await write(view.stdin, '\r');
  await write(view.stdin, '\x1b');
  expect(input.input).toBe('');
  expect(input.images).toEqual(draftImages);
  expect(input.cursorOffset).toBe(0);
  expect(input.queueInput.editing).toBeNull();
  expect(edits).not.toHaveBeenCalled();
});

it('removing queued images explicitly does not remove the skill attachment', async () => {
  let input!: ReturnType<typeof useInputContext>;
  const ObserveInput = () => {
    input = useInputContext();
    return null;
  };
  const edits = vi.fn(async (_id: string, _turn: UserTurn) => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const view = await renderInAct(
    <InputProvider>
      <ObserveInput />
      <ApplicationInputSurface {...props} onEditQueuedMessage={edits} pendingQueuedMessages={[queuedMessage]} />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await act(async () => input.setImages([]));
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenCalledExactlyOnceWith('q-1', { text: 'Inspect', skill: attachedTurn.skill });
});

it('an image-only queued turn keeps its image when saved', async () => {
  const turn = { ...attachedTurn, text: '' };
  const edits = vi.fn(async (_id: string, _turn: UserTurn) => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const view = await renderInAct(
    <InputProvider>
      <ApplicationInputSurface
        {...props}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[{ ...queuedMessage, turn, text: formatUserTurnForDisplay(turn) }]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenCalledExactlyOnceWith('q-1', turn);
});

it('too-late edit fallback submits the complete edited turn', async () => {
  const edits = vi.fn(async () => ({ kind: 'too_late' as const, stage: 'started' as const }));
  const submits = vi.fn();
  const view = await renderInAct(
    <InputProvider>
      <ApplicationInputSurface
        {...props}
        turnInFlight
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, ' carefully');
  await write(view.stdin, '\r');
  expect(submits).toHaveBeenCalledExactlyOnceWith(
    { ...attachedTurn, text: 'Inspect carefully' },
    { busyMode: 'steer' },
  );
});

it('history starts from latest after deliberately clearing a recalled turn', async () => {
  const controller = new MenuControllerImpl();
  const history = {
    ...historyService,
    getTurns: () => [{ text: 'first' }, { text: 'second' }],
  } as unknown as HistoryService;
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface {...props} historyService={history} />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  expect(controller.getSnapshot().editor.text).toBe('second');
  await write(view.stdin, '\x1b\x1b');
  expect(controller.getSnapshot().editor.text).toBe('');
  await write(view.stdin, '\x1b[A');
  expect(controller.getSnapshot().editor.text).toBe('second');
});

it('a completed queued save cannot overwrite text typed while it was pending', async () => {
  let finish!: (value: { kind: 'applied'; stage: 'queued' }) => void;
  const pending = new Promise<{ kind: 'applied'; stage: 'queued' }>((resolve) => {
    finish = resolve;
  });
  const edits = vi.fn(() => pending);
  const controller = new MenuControllerImpl();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ApplicationInputSurface {...props} onEditQueuedMessage={edits} pendingQueuedMessages={[queuedMessage]} />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, ' carefully');
  await write(view.stdin, '\r');
  await write(view.stdin, 'new draft');
  await act(async () => finish({ kind: 'applied', stage: 'queued' }));
  expect(controller.getSnapshot().editor.text).toBe('new draft');
  expect(edits).toHaveBeenCalledTimes(1);
});

it('an earlier save resolving after modal preemption cannot cancel a newer queued edit', async () => {
  let finish!: (value: { kind: 'applied'; stage: 'queued' }) => void;
  const pending = new Promise<{ kind: 'applied'; stage: 'queued' }>((resolve) => {
    finish = resolve;
  });
  const edits = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ kind: 'applied', stage: 'queued' });
  const controller = new MenuControllerImpl();
  const renderSurface = (enabled: boolean) => (
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        {...props}
        enabled={enabled}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>
  );
  const view = await renderInAct(renderSurface(true));
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, '\r');
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await write(view.stdin, ' again');
  await rerenderInAct(view, renderSurface(false));
  await act(async () => finish({ kind: 'applied', stage: 'queued' }));
  await rerenderInAct(view, renderSurface(true));
  expect(view.lastFrame()).toContain('edit queued');
  expect(controller.getSnapshot().editor.text).toBe('Inspect again');
  await write(view.stdin, '\r');
  expect(edits).toHaveBeenLastCalledWith('q-1', { ...attachedTurn, text: 'Inspect again' });
});

it.each([
  { waitingForRejectionReason: true },
  { promptLabel: 'Answer: ' },
  { promptLabel: 'Handoff message: ' },
  { isShellMode: true },
])('special-purpose composer %j cannot submit a suspended queue edit', async (purpose) => {
  const controller = new MenuControllerImpl();
  const edits = vi.fn(async () => ({ kind: 'applied' as const, stage: 'queued' as const }));
  const submits = vi.fn();
  const renderSurface = (special: boolean) => (
    <InputProvider controller={controller}>
      <ApplicationInputSurface
        {...props}
        {...(special ? purpose : {})}
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>
  );
  const view = await renderInAct(renderSurface(false));
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  expect(view.lastFrame()).toContain('edit queued');
  await rerenderInAct(view, renderSurface(true));
  await act(async () => controller.replaceText('different purpose'));
  await write(view.stdin, '\r');
  expect(edits).not.toHaveBeenCalled();
  expect(submits).toHaveBeenCalledExactlyOnceWith({ text: 'different purpose' }, { busyMode: 'steer' });
  await rerenderInAct(view, renderSurface(false));
  expect(view.lastFrame()).not.toContain('edit queued');
});

it('external clear retires queued-edit identity before a new conversation draft', async () => {
  let input!: ReturnType<typeof useInputContext>;
  const ObserveInput = () => {
    input = useInputContext();
    return null;
  };
  const edits = vi.fn();
  const submits = vi.fn();
  const view = await renderInAct(
    <InputProvider>
      <ObserveInput />
      <ApplicationInputSurface
        {...props}
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await act(async () => {
    input.replaceInput('');
    input.setImages([]);
  });
  await write(view.stdin, 'new conversation');
  await write(view.stdin, '\r');
  expect(edits).not.toHaveBeenCalled();
  expect(submits).toHaveBeenCalledExactlyOnceWith({ text: 'new conversation' }, { busyMode: 'steer' });
});

it('external clear such as Ctrl-C resets retained history navigation', async () => {
  let input!: ReturnType<typeof useInputContext>;
  const ObserveInput = () => {
    input = useInputContext();
    return null;
  };
  const history = {
    ...historyService,
    getTurns: () => [{ text: 'first' }, { text: 'second' }],
  } as unknown as HistoryService;
  const view = await renderInAct(
    <InputProvider>
      <ObserveInput />
      <ApplicationInputSurface {...props} historyService={history} />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  expect(input.input).toBe('second');
  await act(async () => input.replaceInput(''));
  await write(view.stdin, '\x1b[A');
  expect(input.input).toBe('second');
});

it('a double Enter while saving a queued edit does not submit it as a new turn', async () => {
  let finish!: (value: { kind: 'applied'; stage: 'queued' }) => void;
  const pending = new Promise<{ kind: 'applied'; stage: 'queued' }>((resolve) => {
    finish = resolve;
  });
  const edits = vi.fn(() => pending);
  const submits = vi.fn();
  const view = await renderInAct(
    <InputProvider>
      <ApplicationInputSurface
        {...props}
        onSubmit={submits}
        onEditQueuedMessage={edits}
        pendingQueuedMessages={[queuedMessage]}
      />
    </InputProvider>,
  );
  await write(view.stdin, '\x1b[A');
  await write(view.stdin, 'e');
  await act(async () => {
    view.stdin.write('\r');
    view.stdin.write('\r');
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  });
  expect(edits).toHaveBeenCalledTimes(1);
  expect(submits).not.toHaveBeenCalled();
  await act(async () => finish({ kind: 'applied', stage: 'queued' }));
});
