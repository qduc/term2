import React, { FC, useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { generateDiff } from '../utils/diff.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';
import { COLOR_TOOL_OUTPUT } from './theme.js';
import DiffView from './DiffView.js';

type DiffStats = {
  added: number;
  removed: number;
};

type Props = {
  command: string;
  output?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  success?: boolean | null;
  failureReason?: string;
  toolName?: string;
  toolArgs?: any;
  isApprovalRejection?: boolean;
  hadApproval?: boolean;
  displayMode?: 'standard' | 'concise';
};

const SEARCH_TOOL_NAMES = new Set(['grep', 'find_files']);

const SEARCH_COMMANDS = ['grep', 'rg', 'find', 'fd', 'ag', 'ack', 'git grep'];

const isSearchLikeTool = (toolName: string | undefined, command: string): boolean => {
  if (toolName && SEARCH_TOOL_NAMES.has(toolName)) return true;
  if (toolName === 'shell' || !toolName) {
    const cmd = command.trim().split(/\s+/)[0] ?? '';
    if (cmd && SEARCH_COMMANDS.some((sc) => cmd === sc || cmd.endsWith(`/${sc}`))) return true;
  }
  return false;
};

const countOutputLines = (output: string | undefined): number => {
  if (!output) return 0;
  return output
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
};

const formatToolArgs = (toolName: string | undefined, args: any): string => {
  if (!args || !toolName) {
    return '';
  }

  const normalizedArgs: any = (() => {
    if (typeof args !== 'string') {
      return args;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();

  if (!normalizedArgs || typeof normalizedArgs !== 'object') {
    return '';
  }

  try {
    // Format based on tool type to match extract-command-messages.ts
    switch (toolName) {
      case 'shell': {
        const command = normalizedArgs.command ?? normalizedArgs.commands;

        const commandText = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' && ') : '';

        if (typeof commandText === 'string' && commandText.trim()) {
          return commandText.length > 80 ? `${commandText.slice(0, 80)}...` : commandText;
        }
        return '';
      }

      case 'grep': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        const parts = [`"${pattern}"`, `"${path}"`];

        if (normalizedArgs.mode === 'literal') parts.push('--literal');
        if (normalizedArgs.case_sensitive) parts.push('--case-sensitive');
        else if (normalizedArgs.case_sensitive === false) parts.push('--ignore-case');
        if (normalizedArgs.file_pattern) parts.push(`--include "${normalizedArgs.file_pattern}"`);
        if (normalizedArgs.exclude_pattern) parts.push(`--exclude "${normalizedArgs.exclude_pattern}"`);

        return parts.join(' ');
      }

      case TOOL_NAME_APPLY_PATCH: {
        const type = normalizedArgs.type || 'unknown';
        const path = normalizedArgs.path || 'unknown';
        return `${type} ${path}`;
      }

      case TOOL_NAME_SEARCH_REPLACE: {
        const path = normalizedArgs.path || 'unknown';
        if (normalizedArgs.replacements) {
          const replacements = normalizedArgs.replacements || [];
          const firstRep = replacements[0] || {};
          const searchContent = firstRep.search_content || '';
          const replaceContent = firstRep.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
          return `"${search}" → "${replace}" "${path}"${countText}`;
        } else {
          const searchContent = normalizedArgs.search_content || '';
          const replaceContent = normalizedArgs.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          return `"${search}" → "${replace}" "${path}"`;
        }
      }

      case TOOL_NAME_CREATE_FILE: {
        const filePath = normalizedArgs.path || 'unknown';
        return `"${filePath}"`;
      }

      case 'ask_mentor': {
        const question = normalizedArgs.question || 'Unknown question';
        return question.length > 80 ? `${question.slice(0, 80)}...` : question;
      }

      default:
        // Generic fallback for unknown tools
        const entries = Object.entries(normalizedArgs);
        if (entries.length === 0) return '';

        return entries
          .map(([key, value]) => {
            const stringValue =
              typeof value === 'string'
                ? value.length > 50
                  ? `${value.slice(0, 50)}...`
                  : value
                : JSON.stringify(value);
            return `${key}=${stringValue}`;
          })
          .join(' ');
    }
  } catch {
    return '';
  }
};

const countDiffStats = (diff: string): DiffStats => {
  let added = 0;
  let removed = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }

  return { added, removed };
};

const CommandMessage: FC<Props> = ({
  command,
  output,
  status,
  success,
  failureReason,
  toolName,
  toolArgs,
  isApprovalRejection,
  hadApproval,
  displayMode = 'standard',
}) => {
  const isRunning = status === 'pending' || status === 'running';
  const [isVisible, setIsVisible] = useState(!isRunning);

  const diff = useMemo(() => {
    if (toolName !== TOOL_NAME_SEARCH_REPLACE || !toolArgs) return '';
    if (toolArgs.replacements) {
      return (toolArgs.replacements || [])
        .map((rep: any) => generateDiff(rep.search_content, rep.replace_content))
        .join('\n');
    }
    return generateDiff(toolArgs.search_content, toolArgs.replace_content);
  }, [toolName, toolArgs?.search_content, toolArgs?.replace_content, toolArgs?.replacements]);

  const createFileDiffLines = useMemo(
    () =>
      toolName === TOOL_NAME_CREATE_FILE && toolArgs
        ? (toolArgs.content ?? '')
            .split('\n')
            .map((line: string) => `+${line}`)
            .join('\n')
        : '',
    [toolName, toolArgs?.content],
  );

  // Parse the denial reason from the JSON wrapper that the tool rejection interceptor
  // produces (e.g. {"output":[{"success":false,"error":"..."}]}).
  const denialReason = useMemo(() => {
    if (!output) return 'Tool execution was not approved.';
    try {
      const parsed = JSON.parse(output);
      if (parsed?.output?.[0]?.error) return parsed.output[0].error;
      if (parsed?.error) return parsed.error;
    } catch {
      /* not JSON, use as-is */
    }
    return output;
  }, [output]);

  const formattedArgs = useMemo(() => {
    return toolArgs ? formatToolArgs(toolName, toolArgs) : '';
  }, [toolName, toolArgs]);

  const changeStats = useMemo<DiffStats | null>(() => {
    const diffText =
      toolName === TOOL_NAME_APPLY_PATCH
        ? toolArgs?.diff
        : toolName === TOOL_NAME_SEARCH_REPLACE
        ? diff
        : toolName === TOOL_NAME_CREATE_FILE
        ? createFileDiffLines
        : '';

    if (!diffText) {
      return null;
    }

    const stats = countDiffStats(diffText);
    return stats.added === 0 && stats.removed === 0 ? null : stats;
  }, [createFileDiffLines, diff, toolArgs?.diff, toolName]);

  const changeStatsElement = changeStats ? (
    <>
      {' '}
      (<Text color="green">+{changeStats.added}</Text>, <Text color="red">-{changeStats.removed}</Text>)
    </>
  ) : null;

  const matchCount = useMemo(() => {
    if (displayMode !== 'concise') return 0;
    if (!isSearchLikeTool(toolName, command)) return 0;
    if (isRunning || isApprovalRejection) return 0;
    return countOutputLines(output);
  }, [displayMode, toolName, command, isRunning, isApprovalRejection, output]);

  const matchCountElement =
    matchCount > 0 ? (
      <>
        {' '}
        <Text>
          ({matchCount} match{matchCount !== 1 ? 'es' : ''})
        </Text>
      </>
    ) : null;

  useEffect(() => {
    if (!isRunning) {
      setIsVisible(true);
      return;
    }

    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, [isRunning]);

  if (!isVisible) {
    return null;
  }

  if (displayMode === 'concise') {
    const isShell = !toolName || toolName === 'shell';
    const displayCommand = isShell ? `$ ${command}` : `[${toolName}] ${formattedArgs}`.trim();

    if (isApprovalRejection) {
      return (
        <Box flexDirection="column">
          <Text color="red">
            <Text bold>✖</Text> <Text>{displayCommand}</Text>
            {changeStatsElement}
          </Text>
          <Text color="red"> → DENIED: {denialReason}</Text>
        </Box>
      );
    }

    if (isRunning) {
      return (
        <Box>
          <Text color="yellow">
            <Text bold>▶</Text> <Text>{displayCommand}</Text>
            {changeStatsElement}
          </Text>
        </Box>
      );
    }

    if (success === false || failureReason) {
      const errorMsg = failureReason || denialReason || 'failed';
      return (
        <Box flexDirection="column">
          <Text color="red">
            <Text bold>✖</Text> <Text>{displayCommand}</Text>
            {changeStatsElement}
            {matchCountElement}
          </Text>
          <Text color="red"> Error: {errorMsg}</Text>
        </Box>
      );
    }

    // Success (one line)
    return (
      <Box>
        <Text color="green">
          <Text bold>✔</Text> <Text>{displayCommand}</Text>
          {changeStatsElement}
          {matchCountElement}
        </Text>
      </Box>
    );
  }
  const outputText = output?.trim() ? output : isRunning ? '(running...)' : '(no output)';
  const displayed =
    outputText && outputText !== '(no output)'
      ? (() => {
          const trimmedOutput = (output || '').trimEnd();
          const lines = trimmedOutput.split('\n');
          const maxLines = 3;
          if (lines.length > maxLines + 1) {
            const firstPart = lines.slice(0, maxLines).join('\n');
            const lastLine = lines[lines.length - 1];
            return `${firstPart}\n... (${lines.length - maxLines - 1} more lines)\n${lastLine}`;
          }
          return output;
        })()
      : outputText;

  // Special handling for apply_patch
  if (toolName === TOOL_NAME_APPLY_PATCH && toolArgs) {
    if (hadApproval) {
      return (
        <Box flexDirection="column">
          <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
        </Box>
      );
    }

    const isCreate = toolArgs.type === 'create_file';
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={isCreate ? 'green' : 'yellow'} bold>
            {isCreate ? '[CREATE FILE]' : '[PATCH]'}
          </Text>
          <Text> {toolArgs.path}</Text>
        </Box>
        {toolArgs.diff && success !== false && <DiffView diff={toolArgs.diff} />}
        {failureReason && <Text color="red">Error: {failureReason}</Text>}
        <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Special handling for search_replace
  if (toolName === TOOL_NAME_SEARCH_REPLACE && toolArgs) {
    // For search_replace that had an approval prompt (user said 'y'), only show output
    if (hadApproval) {
      return (
        <Box flexDirection="column">
          <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
        </Box>
      );
    }

    // For auto-approved search_replace (no approval prompt), show diff + output
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow" bold>
            [SEARCH & REPLACE]
          </Text>
          <Text> {toolArgs.path}</Text>
        </Box>
        <DiffView diff={diff} />
        {failureReason && <Text color="red">Error: {failureReason}</Text>}
        <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Special handling for create_file
  if (toolName === TOOL_NAME_CREATE_FILE && toolArgs) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={success === false ? 'red' : 'green'} bold>
            [CREATE]
          </Text>
          <Text> {toolArgs.path}</Text>
        </Box>
        {success !== false && <DiffView diff={createFileDiffLines} />}
        {failureReason && <Text color="red">Error: {failureReason}</Text>}
        <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Special handling for approval-rejected shell commands: show the denial message
  // with a clear [DENIED] label so the user knows what was attempted and why.
  if (isApprovalRejection) {
    // Extract just the command part for display (e.g. "rm -rf /dangerous").
    const displayCommand = formattedArgs || command;
    return (
      <Box flexDirection="column">
        <Text color="red" bold>
          $ <Text bold>{displayCommand}</Text>
        </Text>
        <Text color="red">→ DENIED: {denialReason}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={success === false ? 'red' : isRunning ? 'yellow' : 'cyan'}>
        $ <Text bold>{command}</Text>
        {isRunning && formattedArgs && command === toolName && <Text color="yellow"> {formattedArgs}</Text>}
      </Text>
      {failureReason && <Text color="red">Error: {failureReason}</Text>}
      <Text color={success === false ? 'red' : COLOR_TOOL_OUTPUT}>{displayed}</Text>
    </Box>
  );
};

export default React.memo(CommandMessage);
