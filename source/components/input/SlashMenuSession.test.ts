import { describe, expect, it, vi } from 'vitest';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { createSlashMenuInteraction } from './SlashMenuSession.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { useSlashCommands } from '../../hooks/use-slash-commands.js';

const makeCommand = (name: string, overrides: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `${name} command`,
  action: () => true,
  ...overrides,
});

const makeSlashState = (overrides: Partial<ReturnType<typeof useSlashCommands>> = {}) =>
  ({
    filteredCommands: [],
    selectedIndex: 0,
    scrollOffset: 0,
    moveUp: vi.fn(),
    moveDown: vi.fn(),
    moveHome: vi.fn(),
    moveEnd: vi.fn(),
    pageUp: vi.fn(),
    pageDown: vi.fn(),
    getSelectedItem: () => undefined,
    executeSelected: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useSlashCommands>);

const openSlashFrame = (commands: SlashCommand[]) => {
  const controller = new MenuControllerImpl({ triggerRegistry: createDefaultTriggerRegistry(commands) });
  controller.applyEditorEdit({ type: 'set-text', text: '/', cursor: 1 });
  const frame = controller.getSnapshot().stack.at(-1);
  if (!frame || frame.kind !== 'slash') throw new Error('expected an open slash frame');
  return { controller, frame };
};

describe('SlashMenuSession tab completion', () => {
  it('Tab inserts the selected command into the input and closes the frame without executing it', () => {
    const action = vi.fn(() => true);
    const rewind = makeCommand('rewind', { expectsArgs: true, action });
    const { controller, frame } = openSlashFrame([rewind]);
    const slash = makeSlashState({ getSelectedItem: () => rewind });

    controller.getInteractionRegistry().register(frame.id, createSlashMenuInteraction(controller, slash));
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });

    const snapshot = controller.getSnapshot();
    expect(snapshot.editor.text).toBe('/rewind ');
    expect(snapshot.editor.cursor).toBe('/rewind '.length);
    expect(snapshot.stack).toHaveLength(0);
    expect(action).not.toHaveBeenCalled();
  });

  it('Tab on a command with a successor trigger inserts the prefix without opening the successor menu', () => {
    const action = vi.fn(() => false);
    const model = makeCommand('model', {
      expectsArgs: true,
      action,
      completion: { type: 'model', trigger: '/model ' },
    });
    const { controller, frame } = openSlashFrame([model]);
    const slash = makeSlashState({ getSelectedItem: () => model });

    controller.getInteractionRegistry().register(frame.id, createSlashMenuInteraction(controller, slash));
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });

    const snapshot = controller.getSnapshot();
    expect(snapshot.editor.text).toBe('/model ');
    // The successor menu (model picker) must not open: the user needs to type
    // the parameter behind the command and press Enter themselves.
    expect(snapshot.stack).toHaveLength(0);
    expect(action).not.toHaveBeenCalled();
  });

  it('Tab with no selected command leaves the frame open and input untouched', () => {
    const { controller, frame } = openSlashFrame([makeCommand('clear')]);
    const slash = makeSlashState({ getSelectedItem: () => undefined });

    controller.getInteractionRegistry().register(frame.id, createSlashMenuInteraction(controller, slash));
    controller.dispatchActiveEvent({ type: 'command', command: 'tab' });

    const snapshot = controller.getSnapshot();
    expect(snapshot.editor.text).toBe('/');
    expect(snapshot.stack).toHaveLength(1);
  });

  it('Enter still executes the selected command', () => {
    const executeSelected = vi.fn();
    const { controller, frame } = openSlashFrame([makeCommand('clear')]);
    const slash = makeSlashState({ executeSelected });

    controller.getInteractionRegistry().register(frame.id, createSlashMenuInteraction(controller, slash));
    controller.dispatchActiveEvent({
      type: 'accept',
      input: { kind: 'composer', text: '/', cursor: 1 },
      selected: undefined,
    });

    expect(executeSelected).toHaveBeenCalled();
    expect(controller.getSnapshot().stack).toHaveLength(0);
  });
});
