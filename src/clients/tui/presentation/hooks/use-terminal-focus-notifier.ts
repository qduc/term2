import { createContext, createElement, useContext, useEffect, useMemo, useRef, type FC, type ReactNode } from 'react';
import { useInput } from 'ink';
import { sendNotification } from '../../../notification-service.js';
import type { ILoggingService, ISettingsService } from '../../../../shared/service-interfaces.js';
import type { TerminalWriter } from '../../../../shared/types/terminal.js';

type TuiServicesContextValue = {
  readonly settingsService?: Pick<ISettingsService, 'get'>;
  readonly loggingService?: ILoggingService;
};

const TuiServicesContext = createContext<TuiServicesContextValue>({});

export const TuiServicesProvider: FC<{
  settingsService: Pick<ISettingsService, 'get'>;
  loggingService: ILoggingService;
  children?: ReactNode;
}> = ({ settingsService, loggingService, children }) => {
  const value = useMemo(() => ({ settingsService, loggingService }), [settingsService, loggingService]);
  return createElement(TuiServicesContext.Provider, { value }, children);
};

interface UseTerminalFocusNotifierOptions {
  stdout: TerminalWriter;
  settingsService?: Pick<ISettingsService, 'get'>;
  loggingService?: ILoggingService;
}

export const useTerminalFocusNotifier = ({
  stdout,
  settingsService,
  loggingService,
}: UseTerminalFocusNotifierOptions) => {
  const contextServices = useContext(TuiServicesContext);
  const resolvedSettingsService = settingsService ?? contextServices.settingsService;
  const resolvedLoggingService = loggingService ?? contextServices.loggingService;
  if (!resolvedSettingsService || !resolvedLoggingService) {
    throw new Error(
      'useTerminalFocusNotifier requires TuiServicesProvider or explicit settingsService and loggingService.',
    );
  }
  // Default to "focused" so we stay silent when focus state is unknown.
  const focusedRef = useRef(true);

  useEffect(() => {
    stdout.write('\x1b[?1004h');
    return () => {
      stdout.write('\x1b[?1004l');
    };
  }, [stdout]);

  useInput((rawInput: string) => {
    resolvedLoggingService.debug('Received terminal raw input sequence', {
      rawInput: JSON.stringify(rawInput),
      length: rawInput.length,
    });

    if (rawInput === '\x1b[I' || rawInput === '[I') {
      resolvedLoggingService.debug('Terminal focus changed to IN (focused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = true;
      return;
    }
    if (rawInput === '\x1b[O' || rawInput === '[O') {
      resolvedLoggingService.debug('Terminal focus changed to OUT (unfocused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = false;
      return;
    }

    if (!focusedRef.current) {
      resolvedLoggingService.debug('Terminal focus restored via user input heuristic', {
        rawInput: JSON.stringify(rawInput),
      });
      focusedRef.current = true;
    }
  });

  return useMemo(
    () => ({
      approvalNeeded() {
        resolvedLoggingService.debug('notifier.approvalNeeded check', {
          focused: focusedRef.current,
          appNotifications: resolvedSettingsService.get('app.notifications'),
          appNotificationsOnApproval: resolvedSettingsService.get('app.notificationsOnApproval'),
        });
        if (focusedRef.current) return;
        if (!resolvedSettingsService.get('app.notifications')) return;
        if (!resolvedSettingsService.get('app.notificationsOnApproval')) return;
        sendNotification('Approval needed', 'Agent is waiting for your approval', { logger: resolvedLoggingService });
      },
      turnComplete() {
        resolvedLoggingService.debug('notifier.turnComplete check', {
          focused: focusedRef.current,
          appNotifications: resolvedSettingsService.get('app.notifications'),
          appNotificationsOnComplete: resolvedSettingsService.get('app.notificationsOnComplete'),
        });
        if (focusedRef.current) return;
        if (!resolvedSettingsService.get('app.notifications')) return;
        if (!resolvedSettingsService.get('app.notificationsOnComplete')) return;
        sendNotification('Response ready', 'Agent has finished responding', { logger: resolvedLoggingService });
      },
    }),
    [resolvedSettingsService, resolvedLoggingService],
  );
};
