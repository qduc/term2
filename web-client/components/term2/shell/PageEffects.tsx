'use client';

import { useEffect, useRef } from 'react';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { startAnimationHeartbeat } from '../../../lib/term2/animationHeartbeat';
import { useChatFacts, useSessionView, useShell, useShellEnv } from './ShellContext';

/** Renders nothing. What the page does to the browser around it: tab title, notifications, animation, shortcuts. */
export function PageEffects() {
  const shell = useShell();
  const { settingsOpen } = useShellEnv();
  const interactionPending = useChatFacts((f) => f.interactionPending);
  const hasStreamingTurn = useChatFacts((f) => f.hasStreamingTurn);
  const hasLiveAnimation = useChatFacts((f) => f.hasLiveAnimation);
  const sessionId = useChatFacts((f) => f.sessionId);
  const status = useSessionView((v) => v.status);
  const notificationsEnabled = useStoreSelector(shell.prefs, (p) => p.notificationsEnabled);

  // Browser tab title badge & optional background notifications.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (interactionPending) {
      document.title = 'Approval needed · term2';
    } else if (hasStreamingTurn) {
      document.title = 'Working… · term2';
    } else {
      document.title = 'term2';
    }
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      notificationsEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      if (interactionPending && prev !== 'awaiting_interaction') {
        new Notification('Term2 needs your approval', { body: 'A tool action is waiting for your decision.' });
      } else if (prev === 'running' && status === 'connected') {
        new Notification('Term2 finished replying', { body: 'Your answer is ready.' });
      }
    }
  }, [interactionPending, hasStreamingTurn, status, notificationsEnabled]);

  // Pause CSS animations when the tab is hidden or the window loses focus so
  // backgrounded and unfocused visible windows avoid compositor/GPU wakeups.
  useEffect(() => {
    const syncVisibilityAndFocus = () => {
      document.documentElement.dataset.pageHidden = document.hidden ? 'true' : 'false';
      document.documentElement.dataset.windowBlurred = document.hasFocus() ? 'false' : 'true';
    };
    const onBlur = () => {
      document.documentElement.dataset.windowBlurred = 'true';
    };
    const onFocus = () => {
      document.documentElement.dataset.windowBlurred = 'false';
    };
    syncVisibilityAndFocus();
    document.addEventListener('visibilitychange', syncVisibilityAndFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibilityAndFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      delete document.documentElement.dataset.pageHidden;
      delete document.documentElement.dataset.windowBlurred;
    };
  }, []);

  // Drive duty-cycled smooth WAAPI breathing only while live indicators exist.
  useEffect(() => {
    if (!hasLiveAnimation) return;
    return startAnimationHeartbeat();
  }, [hasLiveAnimation]);

  // Global Cmd/Ctrl+K quick palette shortcut. The settings page uses it for its search box. It sits above the
  // composer because it calls preventDefault on the welcome screen too, where no composer is mounted.
  useEffect(() => {
    if (settingsOpen) return;
    const onGlobalKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (sessionId) shell.composer.current?.togglePalette();
      }
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [sessionId, settingsOpen, shell]);

  return null;
}
