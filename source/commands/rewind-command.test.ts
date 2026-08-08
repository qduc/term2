import { describe, it, expect, vi } from 'vitest';
import { createRewindSlashCommand, type RewindDisposition } from './rewind-command.js';
import type { RewindItem } from '../utils/conversation/rewind-items.js';

type RewoundTurn = {
  text: string;
  images?: { id: string; data: string; mimeType: string; byteSize: number; displayNumber: number }[];
};

type Harness = {
  getRewindItems: () => readonly RewindItem[];
  rewindToTarget: (item: RewindItem) => RewoundTurn | null;
  sendUserMessage: (input: unknown) => Promise<void>;
  restoreTurnToInput: (turn: RewoundTurn) => void;
  addSystemMessage: (text: string) => void;
  openRewindMenu: (disposition: RewindDisposition) => void;
  onRewind: () => void;
};

const item = (turnNumber: number): RewindItem =>
  ({
    targetId: `target-${turnNumber}` as RewindItem['targetId'],
    uiIndex: turnNumber * 2,
    turnNumber,
    text: `turn ${turnNumber}`,
    imageCount: 0,
    discardedTurns: 1,
    discardedReplies: 0,
    discardedFiles: [],
  } as RewindItem);

const makeHarness = (overrides: Partial<Harness> = {}): Harness => ({
  getRewindItems: vi.fn(() => [item(1), item(2), item(3)]),
  rewindToTarget: vi.fn(() => ({ text: 'restored' })),
  sendUserMessage: vi.fn(async () => {}),
  restoreTurnToInput: vi.fn(),
  addSystemMessage: vi.fn(),
  openRewindMenu: vi.fn(),
  onRewind: vi.fn(),
  ...overrides,
});

const makeCommand = (
  harness: Harness,
  options: {
    name?: string;
    defaultDisposition?: RewindDisposition;
    bareTarget?: 'picker' | 'last';
    aliasOf?: string;
  } = {},
) =>
  createRewindSlashCommand({
    name: options.name ?? 'rewind',
    defaultDisposition: options.defaultDisposition ?? 'edit',
    bareTarget: options.bareTarget ?? 'picker',
    ...(options.aliasOf ? { aliasOf: options.aliasOf } : {}),
    ...harness,
  });

describe('target resolution', () => {
  it('opens the picker when invoked with no arguments and bareTarget is picker', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('');

    expect(harness.openRewindMenu).toHaveBeenCalledWith('edit');
    expect(harness.rewindToTarget).not.toHaveBeenCalled();
  });

  it('rewinds the last turn when invoked with no arguments and bareTarget is last', () => {
    const harness = makeHarness();
    makeCommand(harness, { bareTarget: 'last', defaultDisposition: 'resend' }).action?.('');

    expect(harness.openRewindMenu).not.toHaveBeenCalled();
    expect(harness.rewindToTarget).toHaveBeenCalledWith(item(3));
  });

  it('resolves "last" to the highest turn number', () => {
    const harness = makeHarness({ getRewindItems: vi.fn(() => [item(1), item(7)]) });
    makeCommand(harness).action?.('last');

    expect(harness.rewindToTarget).toHaveBeenCalledWith(item(7));
  });

  it('rewinds to an explicit turn number', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('2');

    expect(harness.rewindToTarget).toHaveBeenCalledWith(item(2));
  });

  it('reports the valid range when the turn number does not exist', () => {
    const harness = makeHarness({ rewindToTarget: vi.fn(() => null) });
    makeCommand(harness).action?.('9');

    expect(harness.rewindToTarget).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('1-3'));
  });

  it('rejects a zero or negative turn number without touching the conversation', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('0');

    expect(harness.rewindToTarget).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalled();
  });

  it('reports nothing to rewind when the conversation has no turns', () => {
    const harness = makeHarness({ getRewindItems: vi.fn(() => []) });
    makeCommand(harness).action?.('last');

    expect(harness.rewindToTarget).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalledWith('Nothing to rewind.');
  });

  it('opens the picker with no turns reported as nothing to rewind', () => {
    const harness = makeHarness({ getRewindItems: vi.fn(() => []) });
    makeCommand(harness).action?.('');

    expect(harness.openRewindMenu).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalledWith('Nothing to rewind.');
  });
});

describe('disposition', () => {
  it('restores the turn to the input box when the disposition is edit', () => {
    const harness = makeHarness({ rewindToTarget: vi.fn(() => ({ text: 'draft me' })) });
    makeCommand(harness).action?.('last');

    expect(harness.restoreTurnToInput).toHaveBeenCalledWith({ text: 'draft me' });
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it('resends the turn when the disposition is resend', () => {
    const harness = makeHarness({ rewindToTarget: vi.fn(() => ({ text: 'try again' })) });
    makeCommand(harness, { defaultDisposition: 'resend' }).action?.('last');

    expect(harness.sendUserMessage).toHaveBeenCalledWith({ text: 'try again' });
    expect(harness.restoreTurnToInput).not.toHaveBeenCalled();
  });

  it('honours an explicit resend argument over the command default', () => {
    const harness = makeHarness();
    makeCommand(harness, { defaultDisposition: 'edit' }).action?.('last resend');

    expect(harness.sendUserMessage).toHaveBeenCalled();
    expect(harness.restoreTurnToInput).not.toHaveBeenCalled();
  });

  it('honours an explicit edit argument over the command default', () => {
    const harness = makeHarness();
    makeCommand(harness, { defaultDisposition: 'resend' }).action?.('2 edit');

    expect(harness.restoreTurnToInput).toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it('accepts the disposition before the target', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('resend 2');

    expect(harness.rewindToTarget).toHaveBeenCalledWith(item(2));
    expect(harness.sendUserMessage).toHaveBeenCalled();
  });

  it('passes the resolved disposition to the picker', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('resend');

    expect(harness.openRewindMenu).toHaveBeenCalledWith('resend');
  });

  it('preserves images so a rewound multimodal turn keeps its attachments', () => {
    const images = [{ id: 'img-1', data: 'abc', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }];
    const harness = makeHarness({ rewindToTarget: vi.fn(() => ({ text: 'look', images })) });
    makeCommand(harness).action?.('last');

    expect(harness.restoreTurnToInput).toHaveBeenCalledWith({ text: 'look', images });
  });

  it('resends images alongside the text', () => {
    const images = [{ id: 'img-1', data: 'abc', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }];
    const harness = makeHarness({ rewindToTarget: vi.fn(() => ({ text: 'look', images })) });
    makeCommand(harness, { defaultDisposition: 'resend' }).action?.('last');

    expect(harness.sendUserMessage).toHaveBeenCalledWith({ text: 'look', images });
  });
});

describe('invalid input', () => {
  it('rejects an unrecognised argument instead of silently rewinding', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('sideways');

    expect(harness.rewindToTarget).not.toHaveBeenCalled();
    expect(harness.openRewindMenu).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('sideways'));
  });

  it('rejects two conflicting targets', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('2 3');

    expect(harness.rewindToTarget).not.toHaveBeenCalled();
    expect(harness.addSystemMessage).toHaveBeenCalled();
  });
});

describe('aliases', () => {
  it('notes the canonical command when invoked through an alias', () => {
    const harness = makeHarness();
    makeCommand(harness, { name: 'undo', aliasOf: 'rewind' }).action?.('last');

    expect(harness.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/rewind'));
    expect(harness.rewindToTarget).toHaveBeenCalled();
  });

  it('does not note anything when invoked as the canonical command', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('last');

    expect(harness.addSystemMessage).not.toHaveBeenCalled();
  });
});

describe('side effects', () => {
  it('redraws after a successful rewind', () => {
    const harness = makeHarness();
    makeCommand(harness).action?.('last');

    expect(harness.onRewind).toHaveBeenCalled();
  });

  it('does not redraw when the rewind was rejected', () => {
    const harness = makeHarness({ rewindToTarget: vi.fn(() => null) });
    makeCommand(harness).action?.('2');

    expect(harness.onRewind).not.toHaveBeenCalled();
  });
});
