import React, { FC, useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { generateDiff } from '../utils/diff.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';
import { getMatchCount, isSearchLikeTool, parseFindFilesOutput, parseGrepOutput } from './command-message-helpers.js';
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

const parseReadFileOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 3 && lines[0]?.startsWith('File: ') && lines[1] === '===') {
    const header = lines[0] ?? '';
    const match = header.match(/File:\s*(.*?)\s*\((\d+)\s*lines\)\s*\[lines\s*(\d+)-(\d+)\]/);
    const contentLines = lines.slice(2);
    if (match) {
      return {
        filePath: match[1],
        totalLines: parseInt(match[2] ?? '0', 10),
        startLine: parseInt(match[3] ?? '1', 10),
        endLine: parseInt(match[4] ?? '1', 10),
        contentLines,
      };
    }
  }
  return null;
};

const parseSubagentOutput = (output: string | undefined, toolArgs: any) => {
  if (!output) return null;

  let status = 'completed';
  let toolsUsed = '';
  let filesChanged = '';
  let mainText = output;

  const lines = output.split('\n');
  const remainingLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('Status: ')) {
      status = line.replace('Status: ', '').trim();
    } else if (line.startsWith('Tools: ') || line.startsWith('Tools used: ')) {
      toolsUsed = line.replace(/Tools( used)?: /, '').trim();
    } else if (line.startsWith('Files changed: ')) {
      filesChanged = line.replace('Files changed: ', '').trim();
    } else if (line.startsWith('Error: ')) {
      status = 'failed';
      remainingLines.push(line);
    } else {
      remainingLines.push(line);
    }
  }

  mainText = remainingLines.join('\n').trim();

  return {
    role: toolArgs?.role ?? 'subagent',
    status,
    toolsUsed,
    filesChanged,
    mainText,
  };
};

const parseWebSearchOutput = (output: string | undefined) => {
  if (!output) return null;

  const normalized = output.replace(/^##\s+/gm, '## ').trim();
  if (!normalized.includes('## Answer') && !normalized.includes('## Search Results')) {
    return null;
  }

  let answer: string | null = null;
  const results: { title: string; url: string; published?: string; content: string }[] = [];

  const sections = normalized.split(/(?:^|\n)##\s+/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('Answer')) {
      answer = trimmed.replace(/^Answer\r?\n/, '').trim();
    } else if (trimmed.startsWith('Search Results')) {
      const resultItems = trimmed.split(/(?:^|\n)###\s+/);
      for (const item of resultItems) {
        const itemTrimmed = item.trim();
        if (!itemTrimmed || itemTrimmed.startsWith('Search Results')) continue;

        const lines = itemTrimmed.split('\n');
        const titleLine = lines[0] ?? '';
        const title = titleLine.replace(/^\d+\.\s*/, '').trim();

        let url = '';
        let published = '';
        const contentLines: string[] = [];

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          if (line.startsWith('**URL:**')) {
            url = line.replace('**URL:**', '').trim();
          } else if (line.startsWith('**Published:**')) {
            published = line.replace('**Published:**', '').trim();
          } else if (line === '---') {
            // End of item
          } else {
            contentLines.push(lines[i] ?? '');
          }
        }

        if (title && url) {
          results.push({
            title,
            url,
            published: published || undefined,
            content: contentLines.join('\n').trim(),
          });
        }
      }
    }
  }

  return { answer, results };
};

const parseWebFetchOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('Title: ') && lines[1]?.startsWith('URL: ')) {
    const title = lines[0].replace('Title: ', '').trim();
    const url = lines[1].replace('URL: ', '').trim();

    let toc: string | null = null;
    let tempFile: string | null = null;
    let notes: string | null = null;
    const contentLines: string[] = [];

    let inToc = false;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmedLine = line.trim();

      if (trimmedLine === '## Table of Contents') {
        inToc = true;
        toc = '';
        continue;
      }

      if (inToc && trimmedLine === '---') {
        inToc = false;
        continue;
      }

      if (inToc) {
        toc += line + '\n';
        continue;
      }

      if (trimmedLine.startsWith('**Note: Content still truncated.')) {
        notes = (notes ? notes + '\n' : '') + trimmedLine;
        continue;
      }

      if (trimmedLine.startsWith('**Full content saved to temp file:')) {
        const match = trimmedLine.match(/temp file:\s*`(.*?)`/);
        if (match) {
          tempFile = match[1] ?? '';
        }
        continue;
      }

      if (trimmedLine.startsWith('The full content has been saved for reference.')) {
        continue;
      }

      contentLines.push(line);
    }

    return {
      title,
      url,
      toc: toc?.trim() || null,
      tempFile,
      notes,
      content: contentLines.join('\n').trim(),
    };
  }
  return null;
};

const parseCodeOutlineOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('FILE ') && lines[1]?.startsWith('LANG ')) {
    const filePath = lines[0].replace('FILE ', '').trim();
    const lang = lines[1].replace('LANG ', '').trim();

    const imports: string[] = [];
    const exports: string[] = [];
    const decls: string[] = [];

    let section: 'imports' | 'exports' | 'decls' | null = null;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (line === 'IMPORTS') {
        section = 'imports';
        continue;
      }
      if (line === 'EXPORTS') {
        section = 'exports';
        continue;
      }
      if (line === 'DECLARATIONS') {
        section = 'decls';
        continue;
      }
      if (line === 'EMPTY') {
        continue;
      }

      if (section === 'imports') {
        imports.push(line);
      } else if (section === 'exports') {
        exports.push(line);
      } else if (section === 'decls') {
        decls.push(line);
      }
    }

    return { filePath, lang, imports, exports, decls };
  }
  return null;
};

const parseCodeContextSearchOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('QUERY ')) {
    const queryType = lines[0].replace('QUERY ', '').trim();

    if (queryType === 'related') {
      const target = lines[1]?.startsWith('TARGET ') ? lines[1].replace('TARGET ', '').trim() : '';
      const relatedFiles: { filePath: string; relations: string }[] = [];

      let currentFile = '';
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line || line === 'NO_RESULTS') continue;
        if (line.startsWith('REL ')) {
          if (currentFile) {
            relatedFiles.push({
              filePath: currentFile,
              relations: line.replace('REL ', '').trim(),
            });
            currentFile = '';
          }
        } else if (!line.startsWith('WARNING ')) {
          currentFile = line;
        }
      }

      return { queryType, target, relatedFiles };
    } else if (queryType === 'symbol') {
      const symbol = lines[1]?.startsWith('SYMBOL ') ? lines[1].replace('SYMBOL ', '').trim() : '';
      const results: { filePath: string; lineNum: number; kind: string; name: string; exported: boolean }[] = [];

      for (let i = 2; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line || line === 'NO_RESULTS' || line.startsWith('WARNING ')) continue;

        const match = line.match(/^(.*?):(\d+)\s+(\w+)\s+(\S+)(?:\s+(exported))?$/);
        if (match) {
          results.push({
            filePath: match[1] ?? '',
            lineNum: parseInt(match[2] ?? '0', 10),
            kind: match[3] ?? '',
            name: match[4] ?? '',
            exported: !!match[5],
          });
        }
      }

      return { queryType, symbol, results };
    }
  }
  return null;
};

const formatToolArgs = (toolName: string | undefined, args: any, displayMode?: 'standard' | 'concise'): string => {
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
        const parts = [`for "${pattern}" in "${path}"`];
        if (normalizedArgs.mode === 'literal') parts.push('--literal');
        if (normalizedArgs.case_sensitive) parts.push('--case-sensitive');
        else if (normalizedArgs.case_sensitive === false) parts.push('--ignore-case');
        if (normalizedArgs.file_pattern) parts.push(`--include "${normalizedArgs.file_pattern}"`);
        if (normalizedArgs.exclude_pattern) parts.push(`--exclude "${normalizedArgs.exclude_pattern}"`);
        return parts.join(' ');
      }

      case 'read_file':
      case 'view_file': {
        const path = normalizedArgs.path || 'unknown';
        const start = normalizedArgs.start_line;
        const end = normalizedArgs.end_line;
        if (start !== undefined || end !== undefined) {
          return `"${path}" (lines ${start ?? 1}-${end ?? 'end'})`;
        }
        return `"${path}"`;
      }

      case 'find_files': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        if (path !== '.' && path) {
          return `matching "${pattern}" in "${path}"`;
        }
        return `matching "${pattern}"`;
      }

      case 'run_subagent': {
        const role = normalizedArgs.role || 'subagent';
        const task = normalizedArgs.task || '';
        const taskPreview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
        return `[${role}] "${taskPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'web_search': {
        const query = normalizedArgs.query || '';
        return `for "${query}"`;
      }

      case 'web_fetch': {
        const url = normalizedArgs.url || '';
        return `"${url}"`;
      }

      case 'ask_mentor': {
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'ask_user': {
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'read_code_outline': {
        const path = normalizedArgs.path || 'unknown';
        return `of "${path}"`;
      }

      case 'code_context_search': {
        const queryType = normalizedArgs.query_type;
        if (queryType === 'symbol') {
          return `for symbol "${normalizedArgs.symbol || ''}"`;
        }
        return `for files related to "${normalizedArgs.path || ''}"`;
      }

      case TOOL_NAME_APPLY_PATCH: {
        const type = normalizedArgs.type || 'unknown';
        const path = normalizedArgs.path || 'unknown';
        return `${type} ${path}`;
      }

      case TOOL_NAME_SEARCH_REPLACE: {
        const path = normalizedArgs.path || 'unknown';
        if (displayMode === 'concise') {
          if (normalizedArgs.replacements) {
            const replacements = normalizedArgs.replacements || [];
            const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
            return `"${path}"${countText}`;
          } else {
            return `"${path}"`;
          }
        }
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
    return toolArgs ? formatToolArgs(toolName, toolArgs, displayMode) : '';
  }, [toolName, toolArgs, displayMode]);

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
    return getMatchCount(toolName, command, output);
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
    const displayAction = (() => {
      const isShell = !toolName || toolName === 'shell';
      if (isShell) {
        return (
          <>
            <Text color="gray">$</Text> <Text>{command}</Text>
          </>
        );
      }

      const argsText = formattedArgs ? ` ${formattedArgs}` : '';
      const renderAction = (verb: string) => (
        <>
          <Text dimColor>{verb}</Text>
          <Text>{argsText}</Text>
        </>
      );

      switch (toolName) {
        case 'grep':
          return renderAction('Searched');
        case 'find_files':
          return renderAction('Searched files');
        case 'read_file':
        case 'view_file':
          return renderAction('Read');
        case TOOL_NAME_APPLY_PATCH:
          return renderAction('Patched');
        case TOOL_NAME_SEARCH_REPLACE:
          return renderAction('Edited');
        case TOOL_NAME_CREATE_FILE:
          return renderAction('Created');
        case 'ask_mentor':
          return renderAction('Asked mentor');
        case 'ask_user':
          return renderAction('Asked user');
        case 'web_search':
          return renderAction('Web searched');
        case 'web_fetch':
          return renderAction('Web fetched');
        case 'read_code_outline':
          return renderAction('Read outline');
        case 'code_context_search':
          return renderAction('Searched context');
        case 'run_subagent':
          return renderAction('Delegated');
        default:
          return (
            <>
              <Text dimColor>[{toolName}]</Text>
              <Text>{argsText}</Text>
            </>
          );
      }
    })();

    if (isApprovalRejection) {
      return (
        <Box flexDirection="column">
          <Text color="red">
            <Text bold>✖</Text> {displayAction}
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
            <Text bold>▶</Text> {displayAction}
            {changeStatsElement}
          </Text>
        </Box>
      );
    }

    if (success === false || failureReason) {
      const errorMsg = failureReason || denialReason || 'failed';
      // Truncate error message like standard mode truncates output
      const truncatedError = (() => {
        const lines = errorMsg.trimEnd().split('\n');
        const maxLines = 3;
        if (lines.length > maxLines + 1) {
          const firstPart = lines.slice(0, maxLines).join('\n');
          const lastLine = lines[lines.length - 1];
          return `${firstPart}\n... (${lines.length - maxLines - 1} more lines)\n${lastLine}`;
        }
        return errorMsg;
      })();
      return (
        <Box flexDirection="column">
          <Text color="red">
            <Text bold>✖</Text> {displayAction}
            {changeStatsElement}
            {matchCountElement}
          </Text>
          <Text color="red"> Error: {truncatedError}</Text>
        </Box>
      );
    }

    // Success (one line)
    return (
      <Box>
        <Text color="green">
          <Text bold>✔</Text> {displayAction}
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

  // Standard mode custom tool renderers
  if (displayMode === 'standard' && success !== false && !failureReason && !isRunning) {
    if (toolName === 'read_file' || toolName === 'view_file') {
      const parsed = parseReadFileOutput(output) as any;
      if (parsed) {
        const { filePath, totalLines, startLine, endLine, contentLines } = parsed;
        const maxContentLines = 10;
        const displayLines: { lineNum: number; content: string }[] = [];
        let truncatedCount = 0;

        if (contentLines.length > maxContentLines + 1) {
          const topCount = maxContentLines - 1;
          for (let i = 0; i < topCount; i++) {
            displayLines.push({ lineNum: startLine + i, content: contentLines[i] ?? '' });
          }
          truncatedCount = contentLines.length - topCount - 1;
          displayLines.push({ lineNum: -1, content: `... (${truncatedCount} lines truncated) ...` });
          displayLines.push({
            lineNum: startLine + contentLines.length - 1,
            content: contentLines[contentLines.length - 1] ?? '',
          });
        } else {
          contentLines.forEach((content: string, i: number) => {
            displayLines.push({ lineNum: startLine + i, content });
          });
        }

        return (
          <Box flexDirection="column" marginY={1}>
            <Box>
              <Text color="cyan" bold>
                📖 [READ FILE]
              </Text>
              <Text>
                {' '}
                {filePath} (Lines {startLine}-{endLine} of {totalLines})
              </Text>
            </Box>
            <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
              {displayLines.map((line, idx) => {
                if (line.lineNum === -1) {
                  return (
                    <Text key={idx} color="gray" dimColor>
                      {line.content}
                    </Text>
                  );
                }
                const lineNumStr = String(line.lineNum).padStart(5, ' ');
                return (
                  <Text key={idx}>
                    <Text color="gray" dimColor>
                      {lineNumStr} │{' '}
                    </Text>
                    <Text color={COLOR_TOOL_OUTPUT}>{line.content}</Text>
                  </Text>
                );
              })}
            </Box>
          </Box>
        );
      }
    }

    if (toolName === 'grep') {
      const parsed = parseGrepOutput(output) as any;
      if (parsed) {
        const { matchesByFile, note } = parsed;
        const filePaths = Object.keys(matchesByFile);
        return (
          <Box flexDirection="column" marginY={1}>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                🔍 [GREP RESULTS]
              </Text>
              <Text> for {toolArgs?.pattern || ''}</Text>
            </Box>
            {filePaths.map((filePath, fileIdx) => {
              const matches = matchesByFile[filePath] ?? [];
              return (
                <Box key={fileIdx} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color="cyan" bold>
                      📄 {filePath}
                    </Text>
                    <Text color="gray">
                      {' '}
                      ({matches.length} match{matches.length !== 1 ? 'es' : ''})
                    </Text>
                  </Box>
                  <Box flexDirection="column" paddingLeft={2}>
                    {matches.map((match: any, matchIdx: number) => {
                      const lineNumStr = String(match.lineNum).padStart(4, ' ');
                      return (
                        <Text key={matchIdx}>
                          <Text color="gray" dimColor>
                            {lineNumStr}:{' '}
                          </Text>
                          <Text color={COLOR_TOOL_OUTPUT}>{match.content}</Text>
                        </Text>
                      );
                    })}
                  </Box>
                </Box>
              );
            })}
            {note && (
              <Box marginTop={1}>
                <Text color="yellow">{note}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'find_files') {
      const parsed = parseFindFilesOutput(output) as any;
      if (parsed) {
        const { files, note } = parsed;
        return (
          <Box flexDirection="column" marginY={1}>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                📂 [FILE SEARCH]
              </Text>
              <Text>
                {' '}
                found {files.length} file{files.length !== 1 ? 's' : ''}
              </Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {files.map((file: string, idx: number) => (
                <Text key={idx} color={COLOR_TOOL_OUTPUT}>
                  📄 {file}
                </Text>
              ))}
            </Box>
            {note && (
              <Box marginTop={1}>
                <Text color="yellow">{note}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'run_subagent') {
      const parsed = parseSubagentOutput(output, toolArgs) as any;
      if (parsed) {
        const { role, status, toolsUsed, filesChanged, mainText } = parsed;
        const statusColor = status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'yellow';
        return (
          <Box flexDirection="column" marginY={1}>
            <Box>
              <Text color="cyan" bold>
                🤖 [SUBAGENT]
              </Text>
              <Text> {role} </Text>
              <Text color={statusColor} bold>
                ({status.toUpperCase()})
              </Text>
            </Box>
            {(toolsUsed || filesChanged) && (
              <Box flexDirection="column" paddingLeft={2} marginY={0.5}>
                {toolsUsed && (
                  <Text color="gray">
                    🛠️ Tools: <Text color="white">{toolsUsed}</Text>
                  </Text>
                )}
                {filesChanged && (
                  <Text color="gray">
                    📝 Changed: <Text color="white">{filesChanged}</Text>
                  </Text>
                )}
              </Box>
            )}
            {mainText && (
              <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
                <Text color={COLOR_TOOL_OUTPUT}>{mainText}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'web_search') {
      const parsed = parseWebSearchOutput(output) as any;
      if (parsed) {
        const { answer, results } = parsed;
        return (
          <Box flexDirection="column" marginY={1}>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                🌐 [WEB SEARCH]
              </Text>
              <Text> "{toolArgs?.query || ''}"</Text>
            </Box>
            {answer && (
              <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
                <Text color="yellow" bold>
                  💡 Answer Summary
                </Text>
                <Text color={COLOR_TOOL_OUTPUT}>{answer}</Text>
              </Box>
            )}
            {results && results.length > 0 && (
              <Box flexDirection="column">
                <Text color="cyan" bold>
                  📋 Search Results:
                </Text>
                {results.map((res: any, idx: number) => (
                  <Box key={idx} flexDirection="column" marginTop={1} paddingLeft={2}>
                    <Text bold color="white">
                      {idx + 1}. {res.title}
                    </Text>
                    <Text color="blue" underline>
                      🔗 {res.url}
                    </Text>
                    {res.published && (
                      <Text color="gray" dimColor>
                        📅 Published: {res.published}
                      </Text>
                    )}
                    <Box marginTop={1}>
                      <Text color={COLOR_TOOL_OUTPUT}>{res.content}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'web_fetch') {
      const parsed = parseWebFetchOutput(output) as any;
      if (parsed) {
        const { title, url, toc, tempFile, notes, content } = parsed;
        const maxLines = 15;
        const contentLines = content.split('\n');
        let displayContent = content;
        let truncatedCount = 0;
        if (contentLines.length > maxLines + 1) {
          const firstPart = contentLines.slice(0, maxLines).join('\n');
          const lastLine = contentLines[contentLines.length - 1];
          truncatedCount = contentLines.length - maxLines - 1;
          displayContent = `${firstPart}\n\n... (${truncatedCount} lines of content truncated for preview) ...\n\n${lastLine}`;
        }
        return (
          <Box flexDirection="column" marginY={1}>
            <Box>
              <Text color="cyan" bold>
                📥 [WEB FETCH]
              </Text>
              <Text> {title}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="blue" underline>
                🔗 {url}
              </Text>
            </Box>
            {toc && (
              <Box flexDirection="column" borderStyle="classic" borderColor="gray" paddingX={1} marginY={1} width={50}>
                <Text color="yellow" bold>
                  📋 Table of Contents
                </Text>
                <Text color="gray">{toc}</Text>
              </Box>
            )}
            {content && (
              <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
                <Text color={COLOR_TOOL_OUTPUT}>{displayContent}</Text>
              </Box>
            )}
            {tempFile && (
              <Box marginTop={1}>
                <Text color="yellow">
                  💾 Full content saved to:{' '}
                  <Text bold color="white">
                    {tempFile}
                  </Text>
                </Text>
              </Box>
            )}
            {notes && (
              <Box marginTop={0.5}>
                <Text color="yellow">⚠️ {notes}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'ask_mentor') {
      return (
        <Box flexDirection="column" marginY={1}>
          <Box>
            <Text color="cyan" bold>
              🧠 [MENTOR QUESTION]
            </Text>
            <Text color="white" italic>
              {' '}
              "{toolArgs?.question || ''}"
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
            <Text color="magenta" bold>
              💬 Mentor Response
            </Text>
            <Text color={COLOR_TOOL_OUTPUT}>{output}</Text>
          </Box>
        </Box>
      );
    }

    if (toolName === 'ask_user') {
      const options = toolArgs?.options;
      return (
        <Box flexDirection="column" marginY={1}>
          <Box>
            <Text color="cyan" bold>
              ❓ [ASK USER]
            </Text>
            <Text color="white"> {toolArgs?.question || 'Unknown question'}</Text>
          </Box>
          {options && Array.isArray(options) && options.length > 0 && (
            <Box paddingLeft={2} marginY={0.5}>
              <Text color="gray">Options: </Text>
              {options.map((opt: string, idx: number) => (
                <Text key={idx} color={idx === 0 ? 'green' : 'white'}>
                  {idx > 0 ? ', ' : ''}[{opt}]{idx === 0 ? ' (Recommended)' : ''}
                </Text>
              ))}
            </Box>
          )}
          <Box paddingLeft={2} marginTop={0.5}>
            <Text color="gray">🗣️ Response: </Text>
            <Text color="green" bold>
              {output || 'No response yet'}
            </Text>
          </Box>
        </Box>
      );
    }

    if (toolName === 'read_code_outline') {
      const parsed = parseCodeOutlineOutput(output) as any;
      if (parsed) {
        const { filePath, lang, imports, exports, decls } = parsed;
        return (
          <Box flexDirection="column" marginY={1}>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                📑 [CODE OUTLINE]
              </Text>
              <Text>
                {' '}
                {filePath} ({lang})
              </Text>
            </Box>
            {imports && imports.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text color="yellow" bold>
                  📦 Imports:
                </Text>
                {imports.map((imp: string, idx: number) => (
                  <Text key={idx} color={COLOR_TOOL_OUTPUT}>
                    {' '}
                    • {imp}
                  </Text>
                ))}
              </Box>
            )}
            {exports && exports.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text color="green" bold>
                  📤 Exports:
                </Text>
                {exports.map((exp: string, idx: number) => (
                  <Text key={idx} color={COLOR_TOOL_OUTPUT}>
                    {' '}
                    • {exp}
                  </Text>
                ))}
              </Box>
            )}
            {decls && decls.length > 0 && (
              <Box flexDirection="column" paddingLeft={2}>
                <Text color="blue" bold>
                  🛠️ Declarations:
                </Text>
                {decls.map((decl: string, idx: number) => (
                  <Text key={idx} color={COLOR_TOOL_OUTPUT}>
                    {' '}
                    • {decl}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'code_context_search') {
      const parsed = parseCodeContextSearchOutput(output) as any;
      if (parsed) {
        const { queryType } = parsed;
        if (queryType === 'related') {
          const { target, relatedFiles } = parsed;
          return (
            <Box flexDirection="column" marginY={1}>
              <Box marginBottom={1}>
                <Text color="cyan" bold>
                  🔗 [RELATED FILES]
                </Text>
                <Text> for {target}</Text>
              </Box>
              {!relatedFiles || relatedFiles.length === 0 ? (
                <Box paddingLeft={2}>
                  <Text color="gray">No related files found.</Text>
                </Box>
              ) : (
                <Box flexDirection="column" paddingLeft={2}>
                  {relatedFiles.map((f: any, idx: number) => (
                    <Box key={idx} flexDirection="column" marginBottom={0.5}>
                      <Text color="white">📄 {f.filePath}</Text>
                      <Text color="gray" dimColor>
                        {' '}
                        Relations: {f.relations}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          );
        } else {
          const { symbol, results } = parsed;
          return (
            <Box flexDirection="column" marginY={1}>
              <Box marginBottom={1}>
                <Text color="cyan" bold>
                  🔍 [SYMBOL SEARCH]
                </Text>
                <Text> "{symbol}"</Text>
              </Box>
              {!results || results.length === 0 ? (
                <Box paddingLeft={2}>
                  <Text color="gray">No symbol declarations found.</Text>
                </Box>
              ) : (
                <Box flexDirection="column" paddingLeft={2}>
                  {results.map((res: any, idx: number) => (
                    <Text key={idx}>
                      <Text color="white">
                        📄 {res.filePath}:{res.lineNum}
                      </Text>
                      <Text color="gray" dimColor>
                        {' '}
                        │{' '}
                      </Text>
                      <Text color="yellow">
                        {res.kind} {res.name}
                      </Text>
                      {res.exported && (
                        <Text color="green" dimColor>
                          {' '}
                          (exported)
                        </Text>
                      )}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        }
      }
    }
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
