import test from 'ava';
import { createShellToolDefinition } from './shell.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import type { ILoggingService } from '../services/service-interfaces.js';

test.serial('shell execute restores previous correlation id after command execution', async (t) => {
  const setCorrelationCalls: Array<string | undefined> = [];
  let clearCorrelationCalls = 0;
  let currentCorrelationId: string | undefined = 'trace-parent';

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
      setCorrelationCalls.push(id);
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('exit 0'));
  t.is(currentCorrelationId, 'trace-parent');
  t.is(clearCorrelationCalls, 0);
  t.true(setCorrelationCalls.length >= 2);
  t.not(setCorrelationCalls[0], 'trace-parent');
  t.is(setCorrelationCalls[setCorrelationCalls.length - 1], 'trace-parent');
});

test.serial('shell execute clears correlation id when no previous correlation exists', async (t) => {
  let currentCorrelationId: string | undefined = undefined;
  let clearCorrelationCalls = 0;

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.is(currentCorrelationId, undefined);
  t.is(clearCorrelationCalls, 1);
});
