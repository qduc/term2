export type UnknownRecord = Record<string, unknown>;

export const asRecord = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;

export const getString = (record: UnknownRecord | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
};

export const getMethod = <TArgs extends unknown[], TResult>(
  target: unknown,
  key: string,
): ((...args: TArgs) => TResult) | null => {
  const record = asRecord(target);
  const candidate = record?.[key];
  return typeof candidate === 'function' ? (candidate as (...args: TArgs) => TResult) : null;
};

export const getCallIdFromObject = (value: unknown): string | undefined => {
  const record = asRecord(value);
  const callId =
    getString(record, 'callId') ??
    getString(record, 'call_id') ??
    getString(record, 'tool_call_id') ??
    getString(record, 'toolCallId') ??
    getString(record, 'id');

  if (callId) {
    return callId;
  }

  const rawItem = asRecord(record?.rawItem);
  return (
    getString(rawItem, 'callId') ??
    getString(rawItem, 'call_id') ??
    getString(rawItem, 'tool_call_id') ??
    getString(rawItem, 'toolCallId') ??
    getString(rawItem, 'id')
  );
};

export const getCommandFromArgs = (args: unknown): string => {
  if (!args) {
    return '';
  }

  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed?.command) {
        return parsed.command;
      }
      if (Array.isArray(parsed?.commands)) {
        return parsed.commands.join('\n');
      }
      return JSON.stringify(parsed);
    } catch {
      return args;
    }
  }

  if (typeof args === 'object') {
    const argsRecord = asRecord(args);
    const cmdFromObject = argsRecord?.command !== undefined ? String(argsRecord.command) : undefined;
    if (Array.isArray(argsRecord?.commands)) {
      return (argsRecord.commands as string[]).join('\n');
    }
    let argsFromObject: string | undefined;
    if (argsRecord?.arguments !== undefined) {
      const rawArguments = argsRecord.arguments;
      if (typeof rawArguments === 'string') {
        try {
          argsFromObject = JSON.stringify(JSON.parse(rawArguments));
        } catch {
          argsFromObject = String(rawArguments);
        }
      } else if (rawArguments !== undefined) {
        argsFromObject = String(rawArguments);
      }
    }
    return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
  }

  return String(args);
};

export interface InterruptionToolInfo {
  toolName: string;
  argumentsText: string;
  rawArguments: unknown;
}

export const getToolInfoFromInterruption = (interruption: unknown): InterruptionToolInfo => {
  const interruptionRecord = asRecord(interruption);
  const toolName = getString(interruptionRecord, 'name') ?? 'unknown';
  const rawArguments = interruptionRecord?.arguments;

  let argumentsText = '';
  if (getString(interruptionRecord, 'type') === 'shell_call') {
    const action = asRecord(interruptionRecord?.action);
    const actionCommands = action?.commands;
    if (actionCommands) {
      argumentsText = Array.isArray(actionCommands) ? actionCommands.join('\n') : String(actionCommands);
    }
  } else {
    argumentsText = getCommandFromArgs(rawArguments);
  }

  return { toolName, argumentsText, rawArguments };
};
