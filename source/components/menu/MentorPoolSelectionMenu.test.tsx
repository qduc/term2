import React from 'react';
import { expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import MentorPoolSelectionMenu from './MentorPoolSelectionMenu.js';

const renderMenu = (
  phase: React.ComponentProps<typeof MentorPoolSelectionMenu>['phase'],
  activeItems: React.ComponentProps<typeof MentorPoolSelectionMenu>['activeItems'],
) => {
  const view = render(
    <MentorPoolSelectionMenu
      phase={phase}
      selectedIndex={0}
      activeItems={activeItems}
      draft={null}
      errorMessage={null}
      fieldErrors={{}}
    />,
  );
  return { frame: view.lastFrame() ?? '', unmount: view.unmount };
};

it('explains an empty pool and does not offer unavailable reorder action', () => {
  const { frame, unmount } = renderMenu('list', [
    { kind: 'action', action: 'add', label: 'Add Entry' },
    { kind: 'action', action: 'save', label: 'Save Changes' },
  ]);

  expect(frame).toContain('0/8 entries');
  expect(frame).toContain('Each entry gets one independent answer');
  expect(frame).toContain('No mentor entries configured yet');
  expect(frame).not.toContain('Reorder Entries');
  unmount();
});

it('shows entry metadata and only offers reorder once there are multiple entries', () => {
  const { frame, unmount } = renderMenu('list', [
    {
      kind: 'entry',
      entry: { model: 'gpt-5', provider: 'openai', reasoningEffort: 'high' },
      index: 0,
      label: 'gpt-5',
    },
    {
      kind: 'entry',
      entry: { model: 'sonnet', provider: undefined, reasoningEffort: undefined },
      index: 1,
      label: 'sonnet',
    },
    { kind: 'action', action: 'reorder', label: 'Reorder Entries' },
    { kind: 'action', action: 'save', label: 'Save Changes' },
  ]);

  expect(frame).toContain('1. gpt-5');
  expect(frame).toContain('Provider: openai');
  expect(frame).toContain('Reasoning: High');
  expect(frame).toContain('2. sonnet');
  expect(frame).toContain('Provider: Inherit mentor provider');
  expect(frame).toContain('Reasoning: Inherit mentor reasoning');
  expect(frame).toContain('Reorder Entries');
  unmount();
});

it('keeps model editing guidance visible for both empty and existing values', () => {
  const empty = render(
    <MentorPoolSelectionMenu
      phase="edit_model"
      selectedIndex={0}
      activeItems={[]}
      draft={{ model: '', _isNew: true }}
      errorMessage={null}
      fieldErrors={{}}
    />,
  );
  expect(empty.lastFrame()).toContain('Type the model ID below and press Enter');
  expect(empty.lastFrame()).toContain('Current value: <empty>');
  empty.unmount();
});

it('labels a new draft as an add flow instead of an edit flow', () => {
  const view = render(
    <MentorPoolSelectionMenu
      phase="edit_fields"
      selectedIndex={0}
      activeItems={[{ kind: 'field', field: 'model', label: 'Model', detail: '<empty>' }]}
      draft={{ model: '', _isNew: true }}
      errorMessage={null}
      fieldErrors={{}}
    />,
  );

  expect(view.lastFrame()).toContain('Add Mentor Entry');
  view.unmount();
});
