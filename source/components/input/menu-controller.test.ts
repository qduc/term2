import { describe, expect, it, vi } from 'vitest';
import {
  MenuControllerImpl,
  TriggerRuleRegistry,
  createInteractionRegistry,
} from './menu-controller.js';
import type { TriggerRule } from './menu-types.js';

describe('MenuControllerImpl', () => {
  it('initializes with default editor snapshot and empty stack', () => {
    const controller = new MenuControllerImpl();
    const snapshot = controller.getSnapshot();

    expect(snapshot.editor).toEqual({
      text: '',
      cursor: 0,
      revision: 1,
    });
    expect(snapshot.stack).toEqual([]);
    expect(snapshot.resolvedCandidateIdentity).toBeNull();
    expect(snapshot.dismissedActivation).toBeNull();
  });

  it('normalizes cursor bounds on editor edits', () => {
    const controller = new MenuControllerImpl({ initialText: 'hello' });

    controller.applyEditorEdit({ type: 'move-cursor', cursor: 100 });
    expect(controller.getSnapshot().editor.cursor).toBe(5);

    controller.applyEditorEdit({ type: 'move-cursor', cursor: -10 });
    expect(controller.getSnapshot().editor.cursor).toBe(0);
  });

  it('reconciles text triggers when matching rule is registered', () => {
    const registry = new TriggerRuleRegistry();
    const slashRule: TriggerRule = {
      id: 'slash',
      priority: 10,
      parse: (editor) => {
        if (editor.text.startsWith('/')) {
          return {
            ruleId: 'slash',
            identity: 'slash-root',
            frame: {
              kind: 'slash',
              binding: {
                trigger: { range: { start: 0, end: 1 }, text: '/' },
                queryStart: 1,
                queryEnd: 'cursor',
                replacement: { start: 0, end: 'cursor' },
              },
            },
          };
        }
        return null;
      },
      successors: [],
    };
    registry.registerRule(slashRule);

    const controller = new MenuControllerImpl({ triggerRegistry: registry });

    controller.applyEditorEdit({ type: 'set-text', text: '/he', cursor: 3 });
    const snapshot = controller.getSnapshot();

    expect(snapshot.stack.length).toBe(1);
    expect(snapshot.stack[0].kind).toBe('slash');
    if ('binding' in snapshot.stack[0]) {
      expect(snapshot.stack[0].binding.query).toBe('he');
      expect(snapshot.stack[0].binding.activationId).toBe('slash-root:1');
    }
  });

  it('handles Escape and dismissal tracking', () => {
    const registry = new TriggerRuleRegistry();
    const pathRule: TriggerRule = {
      id: 'path',
      priority: 10,
      parse: (editor) => {
        if (editor.text.includes('@')) {
          const atIndex = editor.text.indexOf('@');
          return {
            ruleId: 'path',
            identity: `path-${atIndex}`,
            frame: {
              kind: 'path',
              binding: {
                trigger: { range: { start: atIndex, end: atIndex + 1 }, text: '@' },
                queryStart: atIndex + 1,
                queryEnd: 'cursor',
                replacement: { start: atIndex, end: 'cursor' },
              },
            },
          };
        }
        return null;
      },
      successors: [],
    };
    registry.registerRule(pathRule);

    const controller = new MenuControllerImpl({ triggerRegistry: registry });

    controller.applyEditorEdit({ type: 'set-text', text: '@src', cursor: 4 });
    expect(controller.getSnapshot().stack.length).toBe(1);

    controller.escape();
    expect(controller.getSnapshot().stack.length).toBe(0);
    expect(controller.getSnapshot().dismissedActivation).toBe('path-0:1');

    // Typing more query text under same activation does not reopen menu
    controller.applyEditorEdit({ type: 'set-text', text: '@src/', cursor: 5 });
    expect(controller.getSnapshot().stack.length).toBe(0);

    // Clearing trigger resets candidate identity
    controller.applyEditorEdit({ type: 'set-text', text: 'src/', cursor: 4 });
    expect(controller.getSnapshot().resolvedCandidateIdentity).toBeNull();

    // Re-entering trigger opens a new activation
    controller.applyEditorEdit({ type: 'set-text', text: '@src/', cursor: 5 });
    expect(controller.getSnapshot().stack.length).toBe(1);
    const topFrame = controller.getSnapshot().stack[0];
    if (topFrame && 'binding' in topFrame) {
      expect(topFrame.binding.activationId).toBe('path-0:2');
    }
  });

  it('rejects stale frame effects with mismatched frameId or revision', () => {
    const controller = new MenuControllerImpl();
    controller.open({ kind: 'rewind', items: [], initialDisposition: 'edit' });

    const topFrame = controller.getSnapshot().stack[0];
    expect(topFrame).toBeDefined();

    // Dispatch effect with wrong frameId
    controller.dispatch(
      { buffer: { type: 'replace', text: 'new text', cursor: 8 }, stack: { type: 'keep' } },
      { frameId: 'invalid-id', revision: 1 },
    );
    expect(controller.getSnapshot().editor.text).toBe('');

    // Dispatch effect with matching frameId
    controller.dispatch(
      { buffer: { type: 'replace', text: 'new text', cursor: 8 }, stack: { type: 'keep' } },
      { frameId: topFrame.id, revision: 1 },
    );
    expect(controller.getSnapshot().editor.text).toBe('new text');
  });

  it('routes events through active interaction registry', () => {
    const interactions = createInteractionRegistry();
    const handleSpy = vi.fn().mockReturnValue({
      buffer: { type: 'replace', text: 'selected', cursor: 8 },
      stack: { type: 'close-top' },
    });

    const controller = new MenuControllerImpl({ interactionRegistry: interactions });
    controller.open({ kind: 'rewind', items: [], initialDisposition: 'edit' });

    const topFrame = controller.getSnapshot().stack[0];
    interactions.register(topFrame.id, { handle: handleSpy });

    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });

    expect(handleSpy).toHaveBeenCalledWith({ type: 'command', command: 'tab' });
    expect(controller.getSnapshot().editor.text).toBe('selected');
    expect(controller.getSnapshot().stack.length).toBe(0);
  });
});
