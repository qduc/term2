import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  EMPTY_COMPOSER,
  NO_NOTICES,
  initialShellState,
  isCurrentTag,
  step,
} from '../../web-client/lib/term2/shell-machine.ts';

/*
 * shell.machine-rules: the chat shell's policy (web-client/lib/term2/shell-machine.ts) under random user actions
 * and results that arrive late, out of order or not at all. A pending command or late result is resolved, failed
 * or left hanging at random, so a result can name a chat the user has since left.
 *
 * Bounds: at most 30 steps per case; no React, network or browser.
 */

const CHATS = ['chat-1', 'chat-2'];
const FOLDERS = ['folder-1', 'folder-2'];

const user = fc.oneof(
  fc.record({ kind: fc.constant('url'), sessionId: fc.constantFrom(null, ...CHATS) }),
  fc.record({ kind: fc.constant('new_draft'), workspaceId: fc.constantFrom(...FOLDERS) }),
  fc.record({ kind: fc.constant('pick'), approvalMode: fc.constantFrom('ask', 'smart') }),
  fc.record({ kind: fc.constant('type'), input: fc.constantFrom('', 'hello', 'more') }),
  fc.record({ kind: fc.constant('stage'), model: fc.constantFrom(null, 'model-a') }),
  fc.record({
    kind: fc.constant('send'),
    running: fc.boolean(),
    delivery: fc.constantFrom(undefined, 'follow_up'),
    edit: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('discard') }),
  // A chat picked from the list, with its folder when the list knows it.
  fc.record({
    kind: fc.constant('pick_chat'),
    sessionId: fc.constantFrom(...CHATS),
    workspaceId: fc.constantFrom(null, ...FOLDERS),
  }),
  { arbitrary: fc.record({ kind: fc.constant('user') }), weight: 3 },
  // A whole first send in one step (a draft, some text, Send), so later steps reach a chat being created.
  { arbitrary: fc.record({ kind: fc.constant('draft_send'), workspaceId: fc.constantFrom(...FOLDERS) }), weight: 3 },
  // From now on the page reports address-bar changes late (as the router does), or at once again.
  fc.record({ kind: fc.constant('router'), late: fc.boolean() }),
  // A settings change in the open chat; its end arrives later, or never.
  fc.record({ kind: fc.constant('config') }),
  // A settings change whose start names an earlier screen (it must change nothing).
  fc.record({ kind: fc.constant('config_stale') }),
  // A Retry's failure, or a failed switch's draft offer, arriving later for what is shown now.
  fc.record({ kind: fc.constant('retry_fail') }),
  fc.record({ kind: fc.constant('retry_offer') }),
  fc.record({ kind: fc.constant('page_error'), message: fc.constantFrom(null, 'boom') }),
  fc.record({
    kind: fc.constant('panel'),
    action: fc.constantFrom(
      { type: 'TASKS_PANEL_TOGGLED' },
      { type: 'TASKS_PANEL_CLOSED' },
      { type: 'SIDEBAR_SET', open: true },
      { type: 'SIDEBAR_SET', open: false },
      { type: 'DIALOG_OPENED', dialog: 'rewind' },
      { type: 'DIALOG_OPENED', dialog: 'folder' },
      { type: 'DIALOG_CLOSED' },
      { type: 'SKILLS_SET', open: true },
    ),
  }),
  fc.record({ kind: fc.constant('ready') }),
  // A late result that started from what is shown now: an image read, a rewound prompt put back.
  fc.record({ kind: fc.constant('attach') }),
  fc.record({ kind: fc.constant('restore') }),
  // The same accepted boundary reported again, or a later one (a boundary's sequence only grows).
  fc.record({ kind: fc.constant('boundary'), next: fc.boolean() }),
  // Resolve or fail one of the pending commands, picked by index. Weighted so chains of results (a retry's timer,
  // then its second answer) are reached.
  { arbitrary: fc.record({ kind: fc.constant('settle'), index: fc.nat(7), ok: fc.boolean() }), weight: 6 },
);
// Whether the page reports address-bar changes late from the start (the `router` step can change it later).
const script = fc.tuple(fc.boolean(), fc.array(user, { minLength: 1, maxLength: 30, size: 'max' }));

function run([lateFromStart, actions]) {
  let state = initialShellState(null);
  const pending = []; // commands and late results waiting to resolve
  let created = 0;
  let requests = 0;
  // A chat a draft's first send created and that has not been opened yet: { folder, sessionId }. Creating
  // another chat in that folder before it is opened (or the user discards the draft or changes folder) would
  // leave it behind.
  let unopened = null;
  let readyFor = null; // the chat READY_TO_SEND was last fed for
  const runningAt = new Map(); // requestId → whether a turn was running when it was sent
  const submitted = new Set(); // requestIds submitted
  const firstSends = []; // chats a first message was submitted to
  const drains = new Map(); // `${generation}|${boundary}` → asks
  const retryAnswered = new Set(); // `${generation}|${boundary}` whose ask was answered busy
  let configStarts = 0;
  let lateReports = lateFromStart; // the page reports a navigate later, as a pending result
  let configStartTag = null; // the tag of the settings change the machine accepted last
  let boundaries = 0;

  const dispatch = (action) => {
    const before = state;
    const { state: next, commands } = step(state, action);
    // A result whose tag is not current changes nothing.
    if ('tag' in action && !isCurrentTag(before, action.tag))
      assert.equal(next, before, `stale ${action.type} changed state`);
    state = next;
    // The config shown is always the open chat's.
    if (state.config) assert.equal(state.config.sessionId, state.openChat, 'config of another chat is shown');
    if (action.type === 'URL_CHANGED' && action.sessionId !== before.openChat) {
      if (before.pendingFirstSend?.sessionId === action.sessionId)
        // A draft handing off to the chat it created keeps what the user wrote for its first message.
        assert.equal(state.composer, before.composer, 'the handoff lost the first message');
      else {
        // Any other change of chat empties the message box and its notices and drops a send in flight.
        assert.deepEqual(state.composer, EMPTY_COMPOSER, 'the message box survived a chat change');
        assert.deepEqual(state.notices, NO_NOTICES, 'a notice survived a chat change');
        assert.equal(state.sending, null, 'a send survived a chat change');
      }
    }
    // Only the user opens or closes the running tasks panel and the sidebar (#394, #396).
    if (!action.type.startsWith('TASKS_PANEL_'))
      assert.equal(state.panels.tasks, before.panels.tasks, `${action.type} moved the running tasks panel`);
    if (action.type !== 'SIDEBAR_SET')
      assert.equal(state.panels.sidebar, before.panels.sidebar, `${action.type} moved the sidebar`);
    // What the page shows changed: the panels that belong to the old chat are closed.
    if (state.generation !== before.generation) {
      assert.notEqual(state.panels.dialog, 'rewind', "another chat's rewind dialog stayed open");
      assert.equal(state.panels.skills, false, "another chat's skills picker stayed open");
    }
    // P1: what belongs to one chat goes when the page shows something else.
    if (state.generation !== before.generation) {
      assert.equal(state.configApply, null, 'per-chat intent survived a change of what the page shows');
      assert.equal(state.retryError, null, 'per-chat intent survived a change of what the page shows');
      assert.equal(state.retryDraft, null, 'per-chat intent survived a change of what the page shows');
    }
    // P2: one settings change at a time, only in an open chat, and only the one accepted for this screen.
    if (action.type === 'CONFIG_APPLY_STARTED' && state.configApply !== before.configApply) {
      assert.equal(before.configApply, null, 'a settings change replaced one still in flight');
      configStartTag = action.tag;
    }
    if (state.configApply) {
      assert.ok(state.openChat, 'a settings change is in flight with no chat open');
      assert.ok(configStartTag && isCurrentTag(state, configStartTag), 'a settings change from another screen is held');
    }
    // P3: a current end of the held change clears it; any other end changes nothing.
    if (action.type === 'CONFIG_APPLY_SETTLED' && isCurrentTag(before, action.tag)) {
      if (before.configApply?.requestId === action.requestId)
        assert.equal(state.configApply, null, 'the held settings change did not end');
      else assert.equal(next, before, 'another settings change ended the held one');
    }
    // P4: the page's banner changes only when something says so; a chat change leaves it.
    if (state.pageError !== before.pageError) {
      const allowed =
        action.type === 'PAGE_ERROR' ||
        (action.type === 'NEW_DRAFT' && state.pageError === null) ||
        (action.type === 'DRAFT_START_FAILED' && state.pageError === action.message);
      assert.ok(allowed, `${action.type} changed the page's error banner`);
    }
    // P5: picking a chat only records its folder and asks the address bar for it.
    if (action.type === 'CHAT_PICKED') {
      assert.deepEqual(
        commands,
        [{ type: 'navigate', sessionId: action.sessionId }],
        'picking a chat did not navigate',
      );
      assert.deepEqual(
        { ...next, chosenFolder: before.chosenFolder },
        before,
        'picking a chat changed more than the chosen folder',
      );
    }
    // P6: another user signed in: nothing of the previous user's stays.
    if (action.type === 'USER_CHANGED')
      assert.deepEqual(
        commands,
        [{ type: 'navigate', sessionId: null, history: 'replace' }],
        'a user change did not clear the address bar',
      );
    if (action.type === 'SESSION_CREATED' && state.draft?.createdSessionId === action.sessionId)
      unopened = { folder: state.draft.workspaceId, sessionId: action.sessionId };
    // Opening any chat ends it: opening the created chat is the handoff, and opening another one is the user
    // walking away from a send they made (their chat stays in the list, as any sent chat does).
    if (unopened && action.type === 'URL_CHANGED' && action.sessionId !== null) unopened = null;
    if (unopened && (action.type === 'DRAFT_DISCARDED' || action.type === 'USER_CHANGED')) unopened = null;
    if (unopened && action.type === 'NEW_DRAFT' && action.workspaceId !== unopened.folder && !before.starting)
      unopened = null;
    const afterCommands = () => {
      if (action.type === 'CHAT_PICKED' && !lateReports)
        assert.equal(state.openChat, action.sessionId, 'the picked chat did not open');
      if (action.type === 'USER_CHANGED') {
        assert.equal(state.openChat, null, 'the previous user’s chat is still open');
        assert.equal(state.draft, null, 'the previous user’s draft stayed');
        assert.equal(state.sendIntent, null, 'the previous user’s send stayed');
        assert.equal(state.pendingFirstSend, null, 'the previous user’s first message would still be sent');
        assert.equal(state.sending, null, 'the previous user’s message is still on its way');
        assert.equal(state.starting, false, 'the previous user’s chat is still being created');
        assert.deepEqual(state.composer, EMPTY_COMPOSER, 'the previous user’s message box stayed');
      }
    };
    for (const command of commands) {
      if (command.type === 'createSession') {
        assert.ok(state.draft, 'createSession without a draft');
        assert.equal(command.workspaceId, state.draft.workspaceId, 'createSession is not for the chosen folder');
        assert.ok(
          unopened?.folder !== command.workspaceId,
          'a second chat was created in a folder whose unopened chat was left behind',
        );
      }
      if (command.type === 'applyStaged' || (command.type === 'submit' && action.type !== 'STAGED_APPLIED')) {
        // One message at a time: nothing else was on its way.
        assert.equal(before.sending, null, 'a second message started while one was on its way');
      }
      if (command.type === 'submit') {
        const { requestId } = command.message;
        assert.equal(command.tag.sessionId, state.openChat, 'a message was sent to a chat that is not open');
        assert.ok(!submitted.has(requestId), 'a message was submitted twice');
        submitted.add(requestId);
        // Staged picks apply before a message that starts a turn; a steer or queued message leaves them staged.
        if (!runningAt.get(requestId)) assert.equal(state.staged, null, 'a message was sent before its staged picks');
        if (action.type === 'READY_TO_SEND') {
          assert.equal(readyFor, state.openChat, 'a first message was sent before the chat was ready');
          firstSends.push(state.openChat);
        } else assert.ok(action.type === 'SEND_REQUESTED' || action.type === 'STAGED_APPLIED');
      }
      if (command.type === 'drainNotifications') {
        assert.equal(command.tag.sessionId, state.openChat, 'a drain was asked for a chat that is not open');
        const key = `${command.tag.generation}|${command.boundary}`;
        const asks = (drains.get(key) ?? 0) + 1;
        drains.set(key, asks);
        // Once per boundary, and one re-ask only after a busy or failed answer.
        assert.ok(asks <= 2, 'a boundary was drained more than twice');
        if (asks === 2) assert.ok(retryAnswered.has(key), 'a boundary was re-asked without a busy answer');
      }
      if (command.type === 'navigate') {
        // The address bar changes; the page reports it back, at once or later. The runner reports a silent
        // replace itself, at once.
        if (lateReports && command.history !== 'replace')
          pending.push({ type: 'urlReport', sessionId: command.sessionId });
        else dispatch({ type: 'URL_CHANGED', sessionId: command.sessionId });
        continue;
      }
      if (command.type === 'rememberPrompt') continue;
      pending.push(command);
    }
    afterCommands();
  };

  const sendContext = (running) => ({ runningTurnId: running ? 'turn-running' : null });
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
      case 'type':
        dispatch({ type: 'COMPOSER_EDITED', patch: { input: action.input } });
        break;
      case 'stage':
        if (state.openChat)
          dispatch({
            type: 'STAGED_CHANGED',
            staged: action.model ? { modelSelection: { provider: 'p', model: action.model } } : null,
          });
        break;
      case 'send': {
        const requestId = `request-${++requests}`;
        runningAt.set(requestId, action.running);
        dispatch({
          type: 'SEND_REQUESTED',
          requestId,
          context: sendContext(action.running),
          ...(action.delivery ? { delivery: action.delivery } : {}),
          ...(action.edit ? { overrideText: 'edited', textOnly: true } : {}),
        });
        break;
      }
      case 'discard':
        dispatch({ type: 'DRAFT_DISCARDED' });
        break;
      case 'pick_chat':
        dispatch({ type: 'CHAT_PICKED', sessionId: action.sessionId, workspaceId: action.workspaceId });
        break;
      case 'user':
        dispatch({ type: 'USER_CHANGED' });
        break;
      case 'draft_send': {
        dispatch({ type: 'NEW_DRAFT', workspaceId: action.workspaceId });
        dispatch({ type: 'COMPOSER_EDITED', patch: { input: 'first message' } });
        const requestId = `request-${++requests}`;
        runningAt.set(requestId, false);
        dispatch({ type: 'SEND_REQUESTED', requestId, context: sendContext(false) });
        break;
      }
      case 'config_stale':
        if (state.generation > 0)
          dispatch({
            type: 'CONFIG_APPLY_STARTED',
            tag: { sessionId: state.openChat, generation: state.generation - 1 },
            requestId: `config-${++configStarts}`,
          });
        break;
      case 'router':
        lateReports = action.late;
        break;
      case 'config': {
        const tag = { sessionId: state.openChat, generation: state.generation };
        const requestId = `config-${++configStarts}`;
        dispatch({ type: 'CONFIG_APPLY_STARTED', tag, requestId });
        if (state.configApply?.requestId === requestId) pending.push({ type: 'configApply', tag, requestId });
        break;
      }
      case 'retry_fail':
        pending.push({ type: 'retryFail', tag: { sessionId: state.openChat, generation: state.generation } });
        break;
      case 'retry_offer':
        pending.push({ type: 'retryOffer', tag: { sessionId: state.openChat, generation: state.generation } });
        break;
      case 'page_error':
        dispatch({ type: 'PAGE_ERROR', message: action.message });
        break;
      case 'panel':
        dispatch(action.action);
        break;
      case 'ready': {
        if (!state.openChat) break;
        readyFor = state.openChat;
        const requestId = `request-${++requests}`;
        runningAt.set(requestId, false);
        dispatch({ type: 'READY_TO_SEND', sessionId: state.openChat, requestId, context: sendContext(false) });
        break;
      }
      case 'attach':
        pending.push({ type: 'attachRead', tag: { sessionId: state.openChat, generation: state.generation } });
        break;
      case 'restore':
        pending.push({ type: 'restore', tag: { sessionId: state.openChat, generation: state.generation } });
        break;
      case 'boundary':
        if (!state.openChat) break;
        if (action.next || boundaries === 0) boundaries += 1;
        dispatch({ type: 'BOUNDARY', sessionId: state.openChat, boundary: `${state.openChat}:${boundaries}` });
        break;
      case 'settle': {
        if (pending.length === 0) break;
        const [command] = pending.splice(action.index % pending.length, 1);
        switch (command.type) {
          case 'createSession': {
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
            break;
          }
          case 'applyDraftConfig':
            dispatch(
              action.ok
                ? { type: 'DRAFT_CONFIG_APPLIED', tag: command.tag, sessionId: command.sessionId }
                : { type: 'DRAFT_START_FAILED', tag: command.tag, message: 'settings failed' },
            );
            break;
          case 'loadConfig':
            if (command.tag.sessionId)
              dispatch({ type: 'CONFIG_LOADED', tag: command.tag, config: { sessionId: command.tag.sessionId } });
            break;
          case 'applyStaged':
            dispatch({ type: 'STAGED_APPLIED', tag: command.tag, requestId: command.requestId, ok: action.ok });
            break;
          case 'submit': {
            const before = state;
            dispatch({
              type: 'SUBMIT_SETTLED',
              tag: command.tag,
              requestId: command.message.requestId,
              accepted: action.ok,
            });
            // A refused Edit or Retry puts its text back, and only in the chat it was sent from.
            if (!action.ok && command.message.restoreOnFailure && isCurrentTag(before, command.tag))
              assert.equal(state.composer.input, command.message.text, 'a refused resend lost its text');
            break;
          }
          case 'drainNotifications': {
            const key = `${command.tag.generation}|${command.boundary}`;
            if (!action.ok && isCurrentTag(state, command.tag) && state.drain?.boundary === command.boundary)
              retryAnswered.add(key);
            dispatch({ type: 'DRAIN_ANSWERED', tag: command.tag, boundary: command.boundary, retry: !action.ok });
            break;
          }
          case 'later':
            dispatch(command.action);
            break;
          case 'attachRead':
            dispatch({
              type: 'ATTACHMENTS_ADDED',
              tag: command.tag,
              images: [
                { id: `image-${requests}`, name: 'i', previewUrl: '', type: 'image', mediaType: 'image/png', data: '' },
              ],
              error: null,
            });
            break;
          case 'restore':
            dispatch({ type: 'TEXT_RESTORED', tag: command.tag, text: 'restored' });
            break;
          case 'urlReport':
            dispatch({ type: 'URL_CHANGED', sessionId: command.sessionId });
            break;
          case 'configApply':
            dispatch({
              type: 'CONFIG_APPLY_SETTLED',
              tag: command.tag,
              requestId: action.ok ? command.requestId : 'another-change',
            });
            break;
          case 'retryFail':
            dispatch({
              type: 'RETRY_ERROR',
              tag: command.tag,
              error: action.ok ? { turnId: 'turn-1', message: 'could not resend' } : null,
            });
            break;
          case 'retryOffer':
            dispatch({
              type: 'RETRY_DRAFT',
              tag: command.tag,
              draft: action.ok ? { turnId: 'turn-1', model: { provider: 'p', id: 'model-b' } } : null,
            });
            break;
        }
        break;
      }
    }
  }
  // Each first message is sent once: no chat receives two.
  assert.equal(new Set(firstSends).size, firstSends.length, 'a first message was sent twice');
}

export const shellProperties = [
  { name: 'shell.machine-rules', property: fc.property(script, (actions) => run(actions)) },
];
