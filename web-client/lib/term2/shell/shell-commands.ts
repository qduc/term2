/**
 * The one place a `ShellCommand` runs (docs/plans/web-client/web-shell-decomposition.md, section 5.4). Every result
 * goes back through `dispatch` with its command's tag, and `step` drops the stale ones. `dispatch` in
 * shell-runtime.ts is the only caller. No React here.
 */
import { term2Client, Term2ApiError } from '../../api/term2';
import type { BrowserPrefs } from '../browser-prefs';
import type { ServerData } from '../data/server-data';
import * as navigation from '../navigation';
import { isCurrentTag, type ShellAction, type ShellCommand, type ShellState, type Tag } from '../shell-machine';
import type { Store } from '../store';
import type { OpenSession } from './open-session';
import type { ShellLocalState } from './shell-runtime';
import type { ShellOperations } from './shell-operations';

export function createCommandRunner(deps: {
  getState(): ShellState;
  dispatch(action: ShellAction): void;
  session: OpenSession;
  data: ServerData;
  prefs: BrowserPrefs;
  local: Store<ShellLocalState>;
  ops: () => Pick<ShellOperations, 'applySessionConfig'>;
  /** Resolves the promise `ops.send` returned for this request id. */
  sendSettled(requestId: string, accepted: boolean): void;
  localControlEnabled: boolean;
}): (command: ShellCommand) => void {
  const { dispatch, session, data } = deps;

  /** A draft's first send failed; the machine keeps any chat it already created for the retry. */
  const failDraftStart = (tag: Tag, error: unknown) => {
    if (error instanceof Term2ApiError && error.status === 409) void data.chats.refresh().catch(() => undefined);
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Could not start a new chat. Try again or choose a different folder.';
    if (isCurrentTag(deps.getState(), tag)) deps.local.set((local) => ({ ...local, pageError: message }));
    dispatch({ type: 'DRAFT_START_FAILED', tag, message });
  };

  return (command) => {
    switch (command.type) {
      case 'navigate':
        if (command.sessionId) navigation.openChat(command.sessionId);
        else navigation.leaveChat();
        return;
      case 'loadConfig': {
        const id = command.tag.sessionId;
        if (!deps.localControlEnabled || !id) return;
        void term2Client
          .readSessionConfig(id)
          .then((config) => dispatch({ type: 'CONFIG_LOADED', tag: command.tag, config }))
          .catch(() => undefined);
        return;
      }
      case 'createSession':
        void term2Client.createSession(command.workspaceId).then(
          (projection) => {
            data.chatCreated(projection);
            dispatch({ type: 'SESSION_CREATED', tag: command.tag, sessionId: projection.id });
          },
          (error: unknown) => failDraftStart(command.tag, error),
        );
        return;
      case 'applyDraftConfig': {
        const { tag, sessionId: id, config } = command;
        void (async () => {
          if (Object.keys(config).length > 0) {
            const latest = await term2Client.readSessionConfig(id);
            const { result } = await term2Client.updateSessionConfig(id, {
              clientRequestId: crypto.randomUUID(),
              expectedRevision: latest.configRevision,
              admission: 'idle',
              ...config,
            });
            if (!result.ok || result.kind !== 'command_finished')
              throw new Error(!result.ok ? result.message : 'The chat settings have not taken effect.');
          }
          dispatch({ type: 'DRAFT_CONFIG_APPLIED', tag, sessionId: id });
        })().catch((error: unknown) => failDraftStart(tag, error));
        return;
      }
      case 'applyStaged': {
        const { tag, requestId, changes } = command;
        void deps
          .ops()
          .applySessionConfig(changes, tag)
          .then((ok) => {
            dispatch({ type: 'STAGED_APPLIED', tag, requestId, ok });
            if (deps.getState().sending?.requestId !== requestId) deps.sendSettled(requestId, false);
          });
        return;
      }
      case 'submit': {
        const { tag, message } = command;
        void session
          .submit(message.text, {
            delivery: message.delivery,
            ...(message.expectedSteerTurnId ? { expectedSteerTurnId: message.expectedSteerTurnId } : {}),
            ...(message.skill ? { skill: message.skill } : {}),
            ...(message.attachments
              ? { attachments: message.attachments.map(({ type, mediaType, data }) => ({ type, mediaType, data })) }
              : {}),
          })
          .then((accepted) => {
            dispatch({ type: 'SUBMIT_SETTLED', tag, requestId: message.requestId, accepted });
            deps.sendSettled(message.requestId, accepted);
          });
        return;
      }
      case 'rememberPrompt':
        deps.prefs.rememberPrompt(command.text);
        return;
      case 'drainNotifications': {
        const { tag, boundary } = command;
        if (!tag.sessionId) return;
        term2Client
          .controlTask(tag.sessionId, {
            action: 'drain_notifications',
            clientRequestId: `drain_${crypto.randomUUID()}`,
          })
          .then((answer) => dispatch({ type: 'DRAIN_ANSWERED', tag, boundary, retry: answer.drain === 'busy' }))
          .catch((error: unknown) => {
            console.warn('Background notice drain failed', error);
            dispatch({ type: 'DRAIN_ANSWERED', tag, boundary, retry: true });
          });
        return;
      }
      case 'later':
        window.setTimeout(() => dispatch(command.action), command.ms);
        return;
    }
  };
}
