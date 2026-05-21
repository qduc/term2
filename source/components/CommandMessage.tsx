import React, { FC, useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { generateDiff } from '../utils/diff.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';
import { COLOR_TOOL_OUTPUT } from './theme.js';
import DiffView from './DiffView.js';

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

        if (normalizedArgs.case_sensitive) parts.push('--case-sensitive');
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

const CommandMessage: FC<Props> = ({
  command,
  output,
  status,
  success,
  failureReason,
  toolName,
  toolArgs,
  hadApproval,
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

  const formattedArgs = toolArgs ? formatToolArgs(toolName, toolArgs) : '';

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
