import { useEffect, useMemo, useRef } from 'react';
import { useInput } from 'ink';
import { sendNotification } from '../services/notification-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { TerminalWriter } from '../types/terminal.js';

interface UseTerminalFocusNotifierOptions {
  stdout: TerminalWriter;
  settingsService: SettingsService;
  loggingService: LoggingService;
}

export const useTerminalFocusNotifier = ({
  stdout,
  settingsService,
  loggingService,
}: UseTerminalFocusNotifierOptions) => {
  // Default to "focused" so we stay silent when focus state is unknown.
  const focusedRef = useRef(true);

  useEffect(() => {
    stdout.write('\x1b[?1004h');
    return () => {
      stdout.write('\x1b[?1004l');
    };
  }, [stdout]);

  useInput((rawInput: string) => {
    loggingService.debug('Received terminal raw input sequence', {
      rawInput: JSON.stringify(rawInput),
      length: rawInput.length,
    });

    if (rawInput === '\x1b[I' || rawInput === '[I') {
      loggingService.debug('Terminal focus changed to IN (focused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = true;
      return;
    }
    if (rawInput === '\x1b[O' || rawInput === '[O') {
      loggingService.debug('Terminal focus changed to OUT (unfocused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = false;
      return;
    }

    if (!focusedRef.current) {
      loggingService.debug('Terminal focus restored via user input heuristic', {
        rawInput: JSON.stringify(rawInput),
      });
      focusedRef.current = true;
    }
  });

  return useMemo(
    () => ({
      approvalNeeded() {
        loggingService.debug('notifier.approvalNeeded check', {
          focused: focusedRef.current,
          appNotifications: settingsService.get<boolean>('app.notifications'),
          appNotificationsOnApproval: settingsService.get<boolean>('app.notificationsOnApproval'),
        });
        if (focusedRef.current) return;
        if (!settingsService.get<boolean>('app.notifications')) return;
        if (!settingsService.get<boolean>('app.notificationsOnApproval')) return;
        sendNotification('Approval needed', 'Agent is waiting for your approval', { logger: loggingService });
      },
      turnComplete() {
        loggingService.debug('notifier.turnComplete check', {
          focused: focusedRef.current,
          appNotifications: settingsService.get<boolean>('app.notifications'),
          appNotificationsOnComplete: settingsService.get<boolean>('app.notificationsOnComplete'),
        });
        if (focusedRef.current) return;
        if (!settingsService.get<boolean>('app.notifications')) return;
        if (!settingsService.get<boolean>('app.notificationsOnComplete')) return;
        sendNotification('Response ready', 'Agent has finished responding', { logger: loggingService });
      },
    }),
    [settingsService, loggingService],
  );
};
