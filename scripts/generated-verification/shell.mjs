import assert from 'node:assert/strict';
import fc from 'fast-check';
import { initialShellState, isCurrentTag, step } from '../../web-client/lib/term2/shell-machine.ts';

/*
 * shell.machine-rules: the chat shell's selection and draft policy (web-client/lib/term2/shell-machine.ts) under
 * random user actions and results that arrive late, out of order or not at all. A pending command is resolved,
 * failed or left hanging at random, so a result can name a chat the user has since left.
 *
 * Bounds: at most 30 steps per case; no React, network or browser.
 */

const CHATS = ['chat-1', 'chat-2'];
const FOLDERS = ['folder-1', 'folder-2'];

const user = fc.oneof(
  fc.record({ kind: fc.constant('url'), sessionId: fc.constantFrom(null, ...CHATS) }),
  fc.record({ kind: fc.constant('new_draft'), workspaceId: fc.constantFrom(...FOLDERS) }),
  fc.record({ kind: fc.constant('pick'), approvalMode: fc.constantFrom('ask', 'smart') }),
  fc.record({ kind: fc.constant('send') }),
  fc.record({ kind: fc.constant('discard') }),
  fc.record({ kind: fc.constant('ready') }),
  // Resolve or fail one of the pending commands, picked by index.
  fc.record({ kind: fc.constant('settle'), index: fc.nat(5), ok: fc.boolean() }),
);
const script = fc.array(user, { minLength: 1, maxLength: 30, size: 'max' });

function run(actions) {
  let state = initialShellState(null);
  const pending = []; // commands waiting for a result
  let created = 0;
  // A chat a draft's first send created and that has not been opened yet: { folder, sessionId }. Creating
  // another chat in that folder before it is opened (or the user discards the draft or changes folder) would
  // leave it behind.
  let unopened = null;
  let readyFor = null; // the chat READY_TO_SEND was last fed for
  const dispatch = (action) => {
    const before = state;
    const { state: next, commands } = step(state, action);
    // A result whose tag is not current changes nothing.
    if ('tag' in action && !isCurrentTag(before, action.tag))
      assert.equal(next, before, `stale ${action.type} changed state`);
    state = next;
    // The config shown is always the open chat's.
    if (state.config) assert.equal(state.config.sessionId, state.openChat, 'config of another chat is shown');
    if (action.type === 'SESSION_CREATED' && state.draft?.createdSessionId === action.sessionId)
      unopened = { folder: state.draft.workspaceId, sessionId: action.sessionId };
    // Opening any chat ends it: opening the created chat is the handoff, and opening another one is the user
    // walking away from a send they made (their chat stays in the list, as any sent chat does).
    if (unopened && action.type === 'URL_CHANGED' && action.sessionId !== null) unopened = null;
    if (unopened && action.type === 'DRAFT_DISCARDED') unopened = null;
    if (unopened && action.type === 'NEW_DRAFT' && action.workspaceId !== unopened.folder && !before.starting)
      unopened = null;
    for (const command of commands) {
      if (command.type === 'createSession') {
        assert.ok(state.draft, 'createSession without a draft');
        assert.equal(command.workspaceId, state.draft.workspaceId, 'createSession is not for the chosen folder');
        assert.ok(
          unopened?.folder !== command.workspaceId,
          'a second chat was created in a folder whose unopened chat was left behind',
        );
      }
      if (command.type === 'submitFirst') {
        assert.equal(action.type, 'READY_TO_SEND', 'a first message was sent before the chat was ready');
        assert.equal(command.sessionId, state.openChat, 'a first message was sent to another chat');
        assert.equal(readyFor, state.openChat);
      }
      if (command.type === 'navigate') {
        // The address bar changes; the page reports it back.
        dispatch({ type: 'URL_CHANGED', sessionId: command.sessionId });
        continue;
      }
      if (command.type !== 'submitFirst') pending.push(command);
    }
  };
  const submits = [];
  for (const action of actions) {
    switch (action.kind) {
      case 'url':
        dispatch({ type: 'URL_CHANGED', sessionId: action.sessionId });
        break;
      case 'new_draft':
        dispatch({ type: 'NEW_DRAFT', workspaceId: action.workspaceId });
        break;
      case 'pick':
        dispatch({ type: 'DRAFT_CONFIG_PICKED', selection: { approvalMode: action.approvalMode } });
        break;
      case 'send':
        dispatch({ type: 'DRAFT_SEND_REQUESTED' });
        break;
      case 'discard':
        dispatch({ type: 'DRAFT_DISCARDED' });
        break;
      case 'ready':
        if (!state.openChat) break;
        readyFor = state.openChat;
        {
          const { commands } = step(state, { type: 'READY_TO_SEND', sessionId: state.openChat });
          submits.push(...commands.filter((command) => command.type === 'submitFirst'));
        }
        dispatch({ type: 'READY_TO_SEND', sessionId: state.openChat });
        break;
      case 'settle': {
        if (pending.length === 0) break;
        const [command] = pending.splice(action.index % pending.length, 1);
        if (command.type === 'createSession') {
          const sessionId = `new-${++created}`;
          dispatch(
            action.ok
              ? { type: 'SESSION_CREATED', tag: command.tag, sessionId }
              : { type: 'DRAFT_START_FAILED', tag: command.tag, message: 'create failed' },
          );
          // A created chat is only ever taken by a draft for the folder it was created in.
          if (state.draft?.createdSessionId === sessionId)
            assert.equal(
              state.draft.workspaceId,
              command.workspaceId,
              "a chat created in one folder became another folder's draft chat",
            );
        } else if (command.type === 'applyDraftConfig')
          dispatch(
            action.ok
              ? { type: 'DRAFT_CONFIG_APPLIED', tag: command.tag, sessionId: command.sessionId }
              : { type: 'DRAFT_START_FAILED', tag: command.tag, message: 'settings failed' },
          );
        else if (command.type === 'loadConfig' && command.tag.sessionId)
          dispatch({ type: 'CONFIG_LOADED', tag: command.tag, config: { sessionId: command.tag.sessionId } });
        break;
      }
    }
  }
  // Each first message is sent once: no chat receives two.
  const targets = submits.map((command) => command.sessionId);
  assert.equal(new Set(targets).size, targets.length, 'a first message was sent twice');
}

export const shellProperties = [
  { name: 'shell.machine-rules', property: fc.property(script, (actions) => run(actions)) },
];
