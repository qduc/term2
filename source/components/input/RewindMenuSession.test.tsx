// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MenuControllerImpl } from './menu-controller.js';
import { RewindMenuSession } from './RewindMenuSession.js';
import type { RewindItem } from '../../hooks/use-rewind-selection.js';
import { renderInAct } from '../../test-helpers/ink-testing.js';

const item: RewindItem = {
  turnNumber: 2,
  text: 'try again',
  imageCount: 0,
  discardedTurns: 1,
  discardedReplies: 1,
  discardedFiles: [],
};

describe('RewindMenuSession', () => {
  it('registers with the opened frame and accepts the selected item through the intent host', async () => {
    const intentHost = vi.fn();
    const controller = new MenuControllerImpl({ intentHost });
    controller.open({ kind: 'rewind', items: [item], initialDisposition: 'edit' });
    const frame = controller.getSnapshot().stack[0];
    if (!frame || frame.kind !== 'rewind') throw new Error('rewind frame was not opened');

    await renderInAct(
      <RewindMenuSession
        frame={frame}
        active={true}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{}}
      />,
    );

    await act(async () => {
      controller.dispatchActiveEvent({ type: 'command', command: 'tab' });
      await Promise.resolve();
      controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controller.getSnapshot().stack).toHaveLength(0);
    expect(intentHost).toHaveBeenCalledWith({
      intentRequest: {
        id: `rewind:${frame.id}`,
        sourceFrameId: frame.id,
        intent: { type: 'rewind', item, disposition: 'resend' },
      },
    });
  });

  it('closes the controller frame on Escape without invoking the rewind intent', async () => {
    const intentHost = vi.fn();
    const controller = new MenuControllerImpl({ intentHost });
    controller.open({ kind: 'rewind', items: [item], initialDisposition: 'edit' });
    const frame = controller.getSnapshot().stack[0];
    if (!frame || frame.kind !== 'rewind') throw new Error('rewind frame was not opened');

    await renderInAct(
      <RewindMenuSession
        frame={frame}
        active={true}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{}}
      />,
    );

    controller.escape();

    expect(controller.getSnapshot().stack).toHaveLength(0);
    expect(intentHost).not.toHaveBeenCalled();
  });
});
