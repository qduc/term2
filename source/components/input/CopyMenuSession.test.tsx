// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { CopyMenuSession } from './CopyMenuSession.js';
import { MenuControllerImpl } from './menu-controller.js';
import type { CopySelection } from '../../utils/copy-selections.js';

const selections: CopySelection[] = [
  { label: 'Full response', text: 'answer\n```\ncode\n```' },
  { label: 'Code block #1', text: 'code' },
];

describe('CopyMenuSession', () => {
  it('copies the selected code block and closes the menu', async () => {
    const controller = new MenuControllerImpl();
    const onCopySelection = vi.fn();
    controller.open({ kind: 'copy', items: selections });
    const frame = controller.getSnapshot().stack[0];
    if (!frame || frame.kind !== 'copy') throw new Error('copy frame was not opened');

    await renderInAct(
      <CopyMenuSession
        frame={frame}
        active={true}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{ onCopySelection }}
      />,
    );

    await act(async () => {
      controller.dispatchActiveEvent({ type: 'move', direction: 'down' });
      controller.dispatchActiveEvent({ type: 'accept', input: { kind: 'none' }, selected: undefined });
      await Promise.resolve();
    });

    expect(onCopySelection).toHaveBeenCalledWith(selections[1]);
    expect(controller.getSnapshot().stack).toHaveLength(0);
  });

  it('closes without copying when Escape is pressed', async () => {
    const controller = new MenuControllerImpl();
    const onCopySelection = vi.fn();
    controller.open({ kind: 'copy', items: selections });
    const frame = controller.getSnapshot().stack[0];
    if (!frame || frame.kind !== 'copy') throw new Error('copy frame was not opened');

    await renderInAct(
      <CopyMenuSession
        frame={frame}
        active={true}
        controller={controller}
        interactions={controller.getInteractionRegistry()}
        services={{ onCopySelection }}
      />,
    );

    controller.escape();

    expect(onCopySelection).not.toHaveBeenCalled();
    expect(controller.getSnapshot().stack).toHaveLength(0);
  });
});
