import React, { FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import { generateDiff } from '../../utils/output/diff.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import type { CommandMessage as CommandMessageData } from '../../tools/types.js';
import {
  countDiffStats,
  formatToolArgs,
  getFirstParagraph,
  getMatchCount,
  isSearchLikeTool,
  parseCodeOutlineOutput,
  parseFindFilesOutput,
  parseSubagentOutput,
  stripRgErrorLines,
} from './command-message-helpers.js';
import { COLOR_TOOL_OUTPUT, COLOR_MUTED as THEME_COLOR_MUTED } from '../theme.js';
import DiffView from '../layout/DiffView.js';
import { useCommandVisibility } from './useCommandVisibility.js';
import ReadFileRenderer from './ReadFileRenderer.js';
import GrepRenderer from './GrepRenderer.js';
import WebSearchRenderer from './WebSearchRenderer.js';
import WebFetchRenderer from './WebFetchRenderer.js';
import CodeContextSearchRenderer from './CodeContextSearchRenderer.js';

// --- Command Message Theme Colors ---
// Customize these values to change the color scheme per theme.
const COLOR_ERROR = 'red';
const COLOR_SUCCESS = '#A0A0A0';
const COLOR_WARNING = 'yellow';
const COLOR_INFO = 'cyan';
const COLOR_MUTED = 'gray';
const COLOR_CONTENT = 'white';
const COLOR_LINK = 'blue';
const COLOR_SPECIAL = 'magenta';

type Props = {
  command: string;
  output?: string;
  status?: CommandMessageData['status'];
  success?: boolean | null;
  failureReason?: string;
  toolName?: string;
  toolArgs?: any;
  isApprovalRejection?: boolean;
  hadApproval?: boolean;
  displayMode?: 'standard' | 'concise';
  textColor?: string;
  isSubagent?: boolean;
};

const getConciseAskUserResponse = (output: string | undefined): string => {
  if (!output) return 'No response';

  const lines = output.split('\n');
  const answers: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Answer: ')) {
      answers.push(trimmed.slice('Answer: '.length).trim());
    }
  }
  if (answers.length > 0) {
    return answers.join(', ');
  }
  return output;
};

const CommandMessage: FC<Props> = ({
  command,
  output: rawOutput,
  status,
  success,
  failureReason,
  toolName,
  toolArgs,
  isApprovalRejection,
  hadApproval,
  displayMode = 'standard',
  textColor,
  isSubagent = false,
}) => {
  const { isVisible, isRunning } = useCommandVisibility(status);

  const { output, runtime } = useMemo(() => {
    const isShell = !toolName || toolName === 'shell';
    if (isShell && rawOutput) {
      const match = rawOutput.match(/(?:^|\r?\n)Runtime:\s*(\d+ms)(?:\r?\n|$)/);
      if (match) {
        const cleaned = rawOutput.replace(/(?:^|\r?\n)Runtime:\s*\d+ms(?:\r?\n|$)/, '\n').trim();
        return {
          output: cleaned,
          runtime: match[1],
        };
      }
    }
    return { output: rawOutput || '', runtime: undefined };
  }, [toolName, rawOutput]);

  const diff = useMemo(() => {
    if (toolName !== TOOL_NAME_SEARCH_REPLACE || !toolArgs) return '';
    if (toolArgs.replacements) {
      return (toolArgs.replacements || [])
        .map((rep: any) => generateDiff(rep.search_content, rep.replace_content))
        .join('\n');
    }
    return generateDiff(toolArgs.search_content, toolArgs.replace_content);
  }, [toolName, toolArgs]);

  const createFileDiffLines = useMemo(
    () =>
      toolName === TOOL_NAME_CREATE_FILE && toolArgs
        ? (toolArgs.content ?? '')
            .split('\n')
            .map((line: string) => `+${line}`)
            .join('\n')
        : '',
    [toolName, toolArgs],
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
    return toolArgs ? formatToolArgs(toolName, toolArgs, 'concise') : '';
  }, [toolName, toolArgs]);

  const displayAction = useMemo(() => {
    const isShell = !toolName || toolName === 'shell';
    if (isShell) {
      return (
        <>
          <Text color={COLOR_MUTED}>$</Text> <Text bold>{command}</Text>
          {runtime && <Text color={COLOR_MUTED}> ({runtime})</Text>}
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
      case 'glob':
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
  }, [toolName, command, runtime, formattedArgs]);

  const renderStandardHeader = () => {
    const headerColor = success === false ? COLOR_ERROR : isRunning ? COLOR_WARNING : COLOR_INFO;
    const isShell = !toolName || toolName === 'shell';

    if (isShell) {
      return (
        <Box>
          <Text color={headerColor}>{displayAction}</Text>
        </Box>
      );
    }

    return (
      <Box>
        <Text color={headerColor}>
          <Text color={COLOR_MUTED}>$</Text> {displayAction}
        </Text>
      </Box>
    );
  };

  const changeStats = useMemo(() => {
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
      (<Text color="green">+{changeStats.added}</Text> <Text color={COLOR_ERROR}>-{changeStats.removed}</Text>)
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
      <Box paddingLeft={2}>
        <Text color={COLOR_MUTED}>
          ({matchCount} match{matchCount !== 1 ? 'es' : ''})
        </Text>
      </Box>
    ) : null;

  if (!isVisible && !isSubagent) {
    return null;
  }

  if (displayMode === 'concise') {
    if (isSubagent) {
      const isFailed =
        status === 'failed' ||
        status === 'aborted' ||
        isApprovalRejection ||
        success === false ||
        Boolean(failureReason);
      const statusChar = isFailed ? '✖' : isRunning ? '▶' : '✔';
      const actionText = isFailed ? command : displayAction;
      return (
        <Box>
          <Text wrap="truncate" color={THEME_COLOR_MUTED}>
            {statusChar} {actionText}
          </Text>
        </Box>
      );
    }

    if (isApprovalRejection) {
      return (
        <Box flexDirection="column">
          <Text color={textColor || COLOR_SUCCESS}>
            <Text color={COLOR_ERROR} bold>
              ✖
            </Text>{' '}
            {displayAction}
            {changeStatsElement}
          </Text>
          <Text color={textColor || COLOR_SUCCESS}> → DENIED: {denialReason}</Text>
        </Box>
      );
    }

    if (isRunning) {
      return (
        <Box>
          <Text color={COLOR_WARNING}>
            <Text bold>▶</Text> {displayAction}
            {changeStatsElement}
          </Text>
        </Box>
      );
    }

    if (success === false || failureReason) {
      const errorMsg = failureReason || denialReason || 'failed';
      const displayErrorMsg = isSearchLikeTool(toolName, command)
        ? stripRgErrorLines(errorMsg).trim() || 'failed'
        : errorMsg;
      // Truncate error message like standard mode truncates output
      const truncatedError = (() => {
        const lines = displayErrorMsg.trimEnd().split('\n');
        const maxLines = 3;
        if (lines.length > maxLines + 1) {
          const firstPart = lines.slice(0, maxLines).join('\n');
          const lastLine = lines[lines.length - 1];
          return `${firstPart}\n... (${lines.length - maxLines - 1} more lines)\n${lastLine}`;
        }
        return displayErrorMsg;
      })();
      return (
        <Box flexDirection="column">
          <Text color={textColor || COLOR_SUCCESS}>
            <Text color={COLOR_ERROR} bold>
              ✖
            </Text>{' '}
            {displayAction}
            {changeStatsElement}
          </Text>
          {matchCountElement}
          {matchCount === 0 && <Text color={textColor || COLOR_SUCCESS}>{truncatedError}</Text>}
        </Box>
      );
    }

    // Success (one line)
    if (toolName === 'ask_user') {
      const responseText = getConciseAskUserResponse(output);
      return (
        <Box flexDirection="column">
          <Text color={textColor || COLOR_SUCCESS}>
            <Text color={'green'} bold>
              ✔
            </Text>{' '}
            {displayAction}
          </Text>
          <Text color={textColor || COLOR_SUCCESS}> Response: {responseText}</Text>
        </Box>
      );
    }

    if (toolName === 'ask_mentor') {
      const firstParagraph = getFirstParagraph(output, 200);
      return (
        <Box flexDirection="column">
          <Text color={textColor || COLOR_SUCCESS}>
            <Text color={'green'} bold>
              ✔
            </Text>{' '}
            {displayAction}
          </Text>
          <Text color={textColor || COLOR_SUCCESS}> Response: {firstParagraph}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color={textColor || COLOR_SUCCESS}>
          <Text color={'green'} bold>
            ✔
          </Text>{' '}
          {displayAction}
          {changeStatsElement}
        </Text>
        {matchCountElement}
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
          <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        {toolArgs.diff && success !== false && <DiffView diff={toolArgs.diff} />}
        {failureReason && <Text color={COLOR_ERROR}>Error: {failureReason}</Text>}
        <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Special handling for search_replace
  if (toolName === TOOL_NAME_SEARCH_REPLACE && toolArgs) {
    // For search_replace that had an approval prompt (user said 'y'), only show output
    if (hadApproval) {
      return (
        <Box flexDirection="column">
          <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
        </Box>
      );
    }

    // For auto-approved search_replace (no approval prompt), show diff + output
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <DiffView diff={diff} />
        {failureReason && <Text color={COLOR_ERROR}>Error: {failureReason}</Text>}
        <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Special handling for create_file
  if (toolName === TOOL_NAME_CREATE_FILE && toolArgs) {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        {success !== false && <DiffView diff={createFileDiffLines} />}
        {failureReason && <Text color={COLOR_ERROR}>Error: {failureReason}</Text>}
        <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
      </Box>
    );
  }

  // Standard mode custom tool renderers
  if (displayMode === 'standard' && success !== false && !failureReason && !isRunning) {
    if (toolName === 'read_file' || toolName === 'view_file') {
      const result = <ReadFileRenderer output={output} renderStandardHeader={renderStandardHeader} />;
      if (result) return result;
    }

    if (toolName === 'grep') {
      const result = <GrepRenderer output={output} renderStandardHeader={renderStandardHeader} />;
      if (result) return result;
    }

    if (toolName === 'glob') {
      const parsed = parseFindFilesOutput(output) as any;
      if (parsed) {
        const { files, note } = parsed;
        return (
          <Box flexDirection="column">
            <Box marginBottom={1}>{renderStandardHeader()}</Box>
            <Box flexDirection="column" paddingLeft={2}>
              {files.map((file: string, idx: number) => (
                <Text key={idx} color={COLOR_TOOL_OUTPUT}>
                  {file}
                </Text>
              ))}
            </Box>
            {note && (
              <Box marginTop={1}>
                <Text color={COLOR_WARNING}>{note}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'run_subagent') {
      const parsed = parseSubagentOutput(output, toolArgs) as any;
      if (parsed) {
        const { role: _role, status, toolsUsed, filesChanged, mainText } = parsed;
        const _statusColor = status === 'completed' ? COLOR_SUCCESS : status === 'failed' ? COLOR_ERROR : COLOR_WARNING;
        return (
          <Box flexDirection="column">
            {renderStandardHeader()}
            {(toolsUsed || filesChanged) && (
              <Box flexDirection="column" paddingLeft={2} marginY={0.5}>
                {toolsUsed && (
                  <Text color={COLOR_MUTED}>
                    Tools: <Text color={COLOR_CONTENT}>{toolsUsed}</Text>
                  </Text>
                )}
                {filesChanged && (
                  <Text color={COLOR_MUTED}>
                    Changed: <Text color={COLOR_CONTENT}>{filesChanged}</Text>
                  </Text>
                )}
              </Box>
            )}
            {mainText && (
              <Box flexDirection="column" borderStyle="single" borderColor={COLOR_INFO} paddingX={1} marginTop={1}>
                <Text color={COLOR_TOOL_OUTPUT}>{mainText}</Text>
              </Box>
            )}
          </Box>
        );
      }
    }

    if (toolName === 'web_search') {
      const result = <WebSearchRenderer output={output} renderStandardHeader={renderStandardHeader} />;
      if (result) return result;
    }

    if (toolName === 'web_fetch') {
      const result = <WebFetchRenderer output={output} renderStandardHeader={renderStandardHeader} />;
      if (result) return result;
    }

    if (toolName === 'ask_mentor') {
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          <Box flexDirection="column" borderStyle="round" borderColor={COLOR_SPECIAL} paddingX={1} marginTop={1}>
            <Text color={COLOR_SPECIAL} bold>
              Mentor Response
            </Text>
            <Text color={COLOR_TOOL_OUTPUT}>{output}</Text>
          </Box>
        </Box>
      );
    }

    if (toolName === 'ask_user') {
      const options = toolArgs?.options;
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          {options && Array.isArray(options) && options.length > 0 && (
            <Box paddingLeft={2} marginY={0.5}>
              <Text color={COLOR_MUTED}>Options: </Text>
              {options.map((opt: string, idx: number) => (
                <Text key={idx} color={idx === 0 ? COLOR_SUCCESS : COLOR_CONTENT}>
                  {idx > 0 ? ', ' : ''}[{opt}]{idx === 0 ? ' (Recommended)' : ''}
                </Text>
              ))}
            </Box>
          )}
          <Box paddingLeft={2} marginTop={0.5}>
            <Text color={COLOR_MUTED}>Response: </Text>
            <Text color={COLOR_SUCCESS} bold>
              {output || 'No response yet'}
            </Text>
          </Box>
        </Box>
      );
    }

    if (toolName === 'read_code_outline') {
      const parsed = parseCodeOutlineOutput(output) as any;
      if (parsed) {
        const { filePath: _filePath, lang: _lang, imports, exports, decls } = parsed;
        return (
          <Box flexDirection="column">
            <Box marginBottom={1}>{renderStandardHeader()}</Box>
            {imports && imports.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text color={COLOR_WARNING} bold>
                  Imports:
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
                <Text color={COLOR_SUCCESS} bold>
                  Exports:
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
                <Text color={COLOR_LINK} bold>
                  Declarations:
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
      const result = <CodeContextSearchRenderer output={output} renderStandardHeader={renderStandardHeader} />;
      if (result) return result;
    }
  }

  // Special handling for approval-rejected shell commands: show the denial message
  // with a clear [DENIED] label so the user knows what was attempted and why.
  if (isApprovalRejection) {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Text color={COLOR_ERROR}>→ DENIED: {denialReason}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {renderStandardHeader()}
      {failureReason && <Text color={COLOR_ERROR}>Error: {failureReason}</Text>}
      <Text color={success === false ? COLOR_ERROR : COLOR_TOOL_OUTPUT}>{displayed}</Text>
    </Box>
  );
};

export default React.memo(CommandMessage);
