import { describe, expect, it, vi } from 'vitest';
import { MenuControllerImpl, TriggerRuleRegistry, createInteractionRegistry } from './menu-controller.js';
import type { IntentResult, TriggerRule } from './menu-types.js';

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

  it('restores the composer snapshot when the provider frame closes', () => {
    const controller = new MenuControllerImpl({ initialText: 'draft', initialCursor: 3 });

    controller.open({ kind: 'providers' });
    controller.replaceText('provider field', 14);
    controller.close();

    expect(controller.getSnapshot().editor).toEqual({
      text: 'draft',
      cursor: 3,
      revision: 3,
    });
  });

  it('applies a settings value restore BackPolicy on Escape without re-parsing the child', () => {
    const registry = new TriggerRuleRegistry();
    registry.registerRule({
      id: 'settings',
      priority: 10,
      parse: (editor) =>
        editor.text.startsWith('/settings ')
          ? {
              ruleId: 'settings',
              identity: 'settings:set',
              frame: {
                kind: 'settings',
                operation: 'set',
                prefix: '/settings ',
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: '/' },
                  queryStart: 10,
                  queryEnd: 'cursor',
                  replacement: { start: 0, end: 'buffer-end' },
                },
              },
            }
          : null,
      successors: [{ ruleId: 'settings_value', operation: 'push' }],
    });
    registry.registerRule({
      id: 'settings_value',
      priority: 20,
      parse: (editor) =>
        editor.text.startsWith('/settings shell.timeout ')
          ? {
              ruleId: 'settings_value',
              identity: 'settings_value:shell.timeout:25',
              frame: {
                kind: 'settings_value',
                settingKey: 'shell.timeout',
                origin: {
                  type: 'settings-list',
                  operation: 'set',
                  back: {
                    type: 'restore',
                    point: { editor: { text: '/settings shel', cursor: 14, revision: 2 } },
                  },
                },
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: '/' },
                  queryStart: 25,
                  queryEnd: 'cursor',
                  replacement: { start: 25, end: 'cursor' },
                },
              },
            }
          : null,
      successors: [],
    });

    const controller = new MenuControllerImpl({ triggerRegistry: registry });
    controller.applyEditorEdit({ type: 'set-text', text: '/settings shel', cursor: 14 });
    const parent = controller.getSnapshot().stack[0];
    expect(parent?.kind).toBe('settings');

    controller.dispatch(
      {
        buffer: { type: 'replace', text: '/settings shell.timeout ', cursor: 25 },
        stack: {
          type: 'push',
          frame: {
            kind: 'settings_value',
            settingKey: 'shell.timeout',
            origin: {
              type: 'settings-list',
              operation: 'set',
              back: { type: 'restore', point: { editor: { text: '/settings shel', cursor: 14, revision: 2 } } },
            },
            binding: {
              trigger: { range: { start: 0, end: 1 }, text: '/' },
              queryStart: 25,
              queryEnd: 'cursor',
              replacement: { start: 25, end: 'cursor' },
            },
          },
        },
      },
      { frameId: parent!.id, revision: parent && 'binding' in parent ? parent.binding.revision : 2 },
    );

    const child = controller.getSnapshot().stack.at(-1);
    expect(child?.kind).toBe('settings_value');
    controller.escape();

    const snapshot = controller.getSnapshot();
    expect(snapshot.stack).toHaveLength(1);
    expect(snapshot.stack[0]?.kind).toBe('settings');
    expect(snapshot.editor.text).toBe('/settings shel');
    expect(snapshot.editor.cursor).toBe(14);
    expect(snapshot.editor.revision).toBe(4);
    expect('binding' in snapshot.stack[0]! && snapshot.stack[0].binding.revision).toBe(4);
  });

  it('applies model preserve and settings value clear BackPolicies through dispatch and Escape', () => {
    const preserveController = new MenuControllerImpl({ initialText: '/model custom', initialCursor: 13 });
    preserveController.replace({
      kind: 'model',
      target: { type: 'command' },
      back: { type: 'close-preserve-input' },
      binding: {
        trigger: { range: { start: 0, end: 1 }, text: '/' },
        queryStart: 7,
        queryEnd: 'cursor',
        replacement: { start: 7, end: 'buffer-end' },
      },
    });
    const model = preserveController.getSnapshot().stack[0]!;
    preserveController.dispatch(
      { stack: { type: 'close-top' } },
      { frameId: model.id, revision: 'binding' in model ? model.binding.revision : 1 },
    );
    expect(preserveController.getSnapshot().stack).toHaveLength(0);
    expect(preserveController.getSnapshot().editor.text).toBe('/model custom');

    const clearController = new MenuControllerImpl({ initialText: '/effort 2', initialCursor: 9 });
    clearController.replace({
      kind: 'settings_value',
      settingKey: 'effort',
      origin: { type: 'direct-trigger', triggerId: 'effort', back: { type: 'close-clear-input' } },
      binding: {
        trigger: { range: { start: 0, end: 1 }, text: '/' },
        queryStart: 8,
        queryEnd: 'cursor',
        replacement: { start: 8, end: 'cursor' },
      },
    });
    clearController.escape();
    expect(clearController.getSnapshot().stack).toHaveLength(0);
    expect(clearController.getSnapshot().editor).toMatchObject({ text: '', cursor: 0 });
  });

  it('keeps a dispatched child frame authoritative for the next editor transaction', () => {
    const registry = new TriggerRuleRegistry();
    registry.registerRule({
      id: 'parent',
      priority: 10,
      parse: (editor) =>
        editor.text.startsWith('parent')
          ? {
              ruleId: 'parent',
              identity: 'parent',
              frame: {
                kind: 'settings',
                operation: 'set',
                prefix: '/settings ',
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: 'p' },
                  queryStart: 1,
                  queryEnd: 'cursor',
                  replacement: { start: 0, end: 'cursor' },
                },
              },
            }
          : null,
      successors: [{ ruleId: 'child', operation: 'push' }],
    });
    registry.registerRule({
      id: 'child',
      priority: 20,
      parse: (editor) =>
        editor.text.startsWith('child')
          ? {
              ruleId: 'child',
              identity: 'child',
              frame: {
                kind: 'settings_value',
                settingKey: 'key',
                origin: { type: 'direct-trigger', triggerId: 'child', back: { type: 'close-preserve-input' } },
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: 'c' },
                  queryStart: 1,
                  queryEnd: 'cursor',
                  replacement: { start: 0, end: 'cursor' },
                },
              },
            }
          : null,
      successors: [],
    });

    const controller = new MenuControllerImpl({ initialText: 'parent', triggerRegistry: registry });
    controller.applyEditorEdit({ type: 'set-text', text: 'parent', cursor: 6 });
    const parent = controller.getSnapshot().stack[0]!;
    controller.dispatch(
      {
        buffer: { type: 'replace', text: 'child', cursor: 5 },
        stack: {
          type: 'push',
          frame: {
            kind: 'settings_value',
            settingKey: 'key',
            origin: { type: 'direct-trigger', triggerId: 'child', back: { type: 'close-preserve-input' } },
            binding: {
              trigger: { range: { start: 0, end: 1 }, text: 'c' },
              queryStart: 1,
              queryEnd: 'cursor',
              replacement: { start: 0, end: 'cursor' },
            },
          },
        },
      },
      { frameId: parent.id, revision: 'binding' in parent ? parent.binding.revision : 1 },
    );

    const child = controller.getSnapshot().stack.at(-1)!;
    expect(child.kind).toBe('settings_value');
    controller.applyEditorEdit({ type: 'insert', text: '!' });
    expect(controller.getSnapshot().stack.at(-1)?.id).toBe(child.id);
    expect(controller.getSnapshot().activationEpoch).toBe(2);
  });

  it('does not infer a successor from an unrelated frame id prefix', () => {
    const registry = new TriggerRuleRegistry();
    registry.registerRule({
      id: 'frame',
      priority: 10,
      parse: (editor) =>
        editor.text.startsWith('/')
          ? {
              ruleId: 'frame',
              identity: 'settings-root',
              frame: {
                kind: 'settings',
                operation: 'set',
                prefix: '/settings ',
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: '/' },
                  queryStart: 1,
                  queryEnd: 'cursor',
                  replacement: { start: 0, end: 'cursor' },
                },
              },
            }
          : null,
      successors: [{ ruleId: 'settings-value', operation: 'push' }],
    });
    registry.registerRule({
      id: 'settings-value',
      priority: 20,
      parse: (editor) =>
        editor.text.startsWith('/value ')
          ? {
              ruleId: 'settings-value',
              identity: 'settings-value-root',
              frame: {
                kind: 'settings_value',
                settingKey: 'key',
                origin: { type: 'direct-trigger', triggerId: 'value', back: { type: 'close-clear-input' } },
                binding: {
                  trigger: { range: { start: 0, end: 1 }, text: '/' },
                  queryStart: 7,
                  queryEnd: 'cursor',
                  replacement: { start: 7, end: 'cursor' },
                },
              },
            }
          : null,
      successors: [],
    });

    const controller = new MenuControllerImpl({ triggerRegistry: registry });
    controller.applyEditorEdit({ type: 'set-text', text: '/', cursor: 1 });
    const firstFrame = controller.getSnapshot().stack[0];
    expect(firstFrame?.kind).toBe('settings');

    controller.applyEditorEdit({ type: 'set-text', text: '/value ', cursor: 7 });

    expect(controller.getSnapshot().stack).toHaveLength(1);
    expect(controller.getSnapshot().stack[0]?.kind).toBe('settings_value');
  });

  it('delivers asynchronous intent results to the originating interaction', async () => {
    const interactions = createInteractionRegistry();
    let resolveIntent: ((result: { id: string; sourceFrameId: string; ok: true }) => void) | undefined;
    const intentHost = vi.fn(
      () =>
        new Promise<IntentResult>((resolve) => {
          resolveIntent = resolve as typeof resolveIntent;
        }),
    );
    const handle = vi
      .fn()
      .mockReturnValueOnce({
        stack: { type: 'keep' },
        intent: {
          id: 'intent-1',
          sourceFrameId: 'frame-1',
          intent: { type: 'reset-setting', key: 'shell.timeout' },
        },
      })
      .mockReturnValueOnce(undefined);

    const controller = new MenuControllerImpl({ interactionRegistry: interactions, intentHost });
    controller.open({ kind: 'rewind', items: [], initialDisposition: 'edit' });
    const frame = controller.getSnapshot().stack[0];
    interactions.register(frame.id, { handle });

    controller.dispatchActiveEvent({ type: 'command', command: 'refresh' });
    resolveIntent?.({ id: 'intent-1', sourceFrameId: frame.id, ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(handle).toHaveBeenLastCalledWith({
      id: 'intent-1',
      sourceFrameId: frame.id,
      ok: true,
    });
  });
});
