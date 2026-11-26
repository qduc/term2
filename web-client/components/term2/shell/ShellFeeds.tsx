'use client';

import { useEffect, useRef } from 'react';
import { forgetChatSilently } from '../../../lib/term2/navigation';
import { useChatFacts, useShell, useShellState } from './ShellContext';

/**
 * Renders nothing. The only effects in the chat page that dispatch: each turns a prop, or a fact derived from the
 * open chat, into a machine action after the commit (docs/plans/web-client/web-shell-decomposition.md, section 5.3).
 * They stay effects on purpose: a store subscription would dispatch inside another dispatch's notification. A new
 * feed belongs here, where the web-shell-effects rule counts it.
 */
export function ShellFeeds({ initialSessionId, authUserId }: { initialSessionId: string | null; authUserId: string | null }) {
  const shell = useShell();
  const { dispatch } = shell;

  // The address bar owns the open chat.
  useEffect(() => {
    dispatch({ type: 'URL_CHANGED', sessionId: initialSessionId });
  }, [initialSessionId, dispatch]);

  // Open the sidebar by default on desktop screens and load saved UI preferences.
  useEffect(() => {
    if (window.innerWidth >= 768) dispatch({ type: 'SIDEBAR_SET', open: true });
    shell.prefs.hydrate();
  }, [dispatch, shell.prefs]);

  // Another user signed in: no chat, no draft and an empty message box.
  const prevUserIdRef = useRef(authUserId);
  useEffect(() => {
    if (prevUserIdRef.current !== authUserId) {
      prevUserIdRef.current = authUserId;
      forgetChatSilently();
      dispatch({ type: 'URL_CHANGED', sessionId: null });
      dispatch({ type: 'DRAFT_DISCARDED' });
    }
  }, [authUserId, dispatch]);

  // A draft's first message goes once its new chat is configured, unblocked and live; the machine sends it once.
  const readyToSend = useChatFacts((f) => f.readyToSend);
  const sessionId = useChatFacts((f) => f.sessionId);
  const runningTurnId = useChatFacts((f) => f.runningTurnId);
  const pendingFirstSend = useShellState((s) => s.pendingFirstSend);
  useEffect(() => {
    if (readyToSend && sessionId && pendingFirstSend?.sessionId === sessionId)
      dispatch({ type: 'READY_TO_SEND', sessionId, requestId: crypto.randomUUID(), context: { runningTurnId } });
  }, [readyToSend, sessionId, pendingFirstSend, runningTurnId, dispatch]);

  // A background task that finishes while the chat is idle only records a notice; the Session admits the silent
  // turn that tells the agent once an attached client asks it to drain (the TUI does the same). The machine asks
  // once per accepted boundary, with one delayed re-ask after a busy or failed answer.
  const drainBoundary = useChatFacts((f) => f.drainBoundary);
  useEffect(() => {
    if (drainBoundary && sessionId) dispatch({ type: 'BOUNDARY', sessionId, boundary: drainBoundary });
  }, [drainBoundary, sessionId, dispatch]);

  // A status that follows a tool row waits for the machine's timer so a quick next step does not flash it.
  const liveStatus = useChatFacts((f) => f.liveStatus);
  const deferLiveStatus = useChatFacts((f) => f.deferLiveStatus);
  useEffect(() => {
    dispatch({ type: 'LIVE_STATUS', text: liveStatus, defer: deferLiveStatus });
  }, [liveStatus, deferLiveStatus, dispatch]);

  return null;
}
