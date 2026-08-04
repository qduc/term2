import React, { FC } from 'react';
import os from 'node:os';
import { Box, Text, useInput } from 'ink';
import {
  READ_FILE_SESSION_APPROVE_ANSWER,
  supportsFolderSessionRead,
  type ApprovalDescriptor,
} from '../../contracts/conversation.js';
import { resolveSessionReadFolder } from '../../services/approval/session-read-grant-target.js';
import { generateDiff } from '../../utils/output/diff.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_ASK_USER, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import {
  ASK_USER_CUSTOM_ANSWER_LABEL,
  ASK_USER_DECLINE_LABEL,
  ASK_USER_DECLINE_RESULT,
  ASK_USER_SUBMIT_LABEL,
  ASK_USER_PREV_QUESTION_LABEL,
  ASK_USER_NEXT_QUESTION_LABEL,
} from '../../tools/agent/ask-user-constants.js';
import DiffView from '../layout/DiffView.js';
import { requestsDockerHostControl } from '../../utils/shell/sandbox/docker-host-control.js';

type Props = {
  approval: ApprovalDescriptor;
  onApprove: (answer?: string) => void;
  onReject: () => void;
  onCancel?: () => void;
  onTypeAnswer?: () => void;
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
  currentQuestionIndex?: number;
  waitingForAskUserAnswer?: boolean;
};

type QuestionItem = {
  question: string;
  options?: {
    label: string;
    description?: string;
  }[];
  is_multi_select?: boolean;
};

type AskUserArgs = {
  questions: QuestionItem[];
};

type ApplyPatchArgs = {
  type: 'create_file' | 'update_file' | 'delete_file';
  path: string;
  diff?: string;
};

type ShellArgs = {
  commands?: string;
  command?: string;
  cwd?: string;
  timeout_ms?: number;
  max_output_length?: number;
};

type ShellApprovalArgs = ShellArgs & {
  sandbox?: 'default' | 'unsandboxed';
};

function parseShellApprovalArgs(input: unknown): ShellApprovalArgs | null {
  if (input === null || input === undefined) {
    return null;
  }

  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  const command = typeof record.command === 'string' ? record.command : undefined;
  const commands = typeof record.commands === 'string' ? record.commands : undefined;

  if (!command && !commands) {
    return null;
  }

  if (record.sandbox !== undefined && record.sandbox !== 'default' && record.sandbox !== 'unsandboxed') {
    return null;
  }

  if (record.cwd !== undefined && typeof record.cwd !== 'string') {
    return null;
  }

  if (record.timeout_ms !== undefined && typeof record.timeout_ms !== 'number') {
    return null;
  }

  if (record.max_output_length !== undefined && typeof record.max_output_length !== 'number') {
    return null;
  }

  return {
    ...(command !== undefined ? { command } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(record.sandbox !== undefined ? { sandbox: record.sandbox as 'default' | 'unsandboxed' } : {}),
    ...(record.cwd !== undefined ? { cwd: record.cwd as string } : {}),
    ...(record.timeout_ms !== undefined ? { timeout_ms: record.timeout_ms as number } : {}),
    ...(record.max_output_length !== undefined ? { max_output_length: record.max_output_length as number } : {}),
  };
}

type SearchReplaceArgs = {
  path: string;
  replacements: {
    search_content: string;
    replace_content: string;
  }[];
};

type CreateFileArgs = {
  path: string;
  content: string;
};

const operationLabels: Record<string, { label: string; color: string }> = {
  create_file: { label: 'CREATE', color: 'green' },
  update_file: { label: 'UPDATE', color: 'yellow' },
  delete_file: { label: 'DELETE', color: 'red' },
};

const ApplyPatchPrompt: FC<{ args: ApplyPatchArgs }> = ({ args }) => {
  const op = operationLabels[args.type] || { label: args.type, color: 'white' };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={op.color} bold>
          [{op.label}]
        </Text>
        <Text> {args.path}</Text>
      </Box>
      {args.diff && <DiffView diff={args.diff} />}
    </Box>
  );
};

const ShellPrompt: FC<{ args: ShellArgs }> = ({ args }) => {
  const cmd = args.command ?? args.commands ?? '';
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text bold color="cyan">
          {cmd}
        </Text>
      </Box>
      {args.cwd && (
        <Box>
          <Text color="#64748b">Cwd: {args.cwd}</Text>
        </Box>
      )}
      {args.timeout_ms && (
        <Box>
          <Text color="#64748b">Timeout: {args.timeout_ms}ms</Text>
        </Box>
      )}
      {args.max_output_length && (
        <Box>
          <Text color="#64748b">Max output: {args.max_output_length} chars</Text>
        </Box>
      )}
    </Box>
  );
};

const SearchReplacePrompt: FC<{ args: SearchReplaceArgs }> = ({ args }) => {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold>
          [SEARCH & REPLACE]
        </Text>
        <Text> {args.path}</Text>
      </Box>
      {(args.replacements || []).map((rep, idx) => {
        const diff = generateDiff(rep.search_content, rep.replace_content);
        return (
          <Box key={idx} flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
            {args.replacements.length > 1 && <Text color="gray">Replacement #{idx + 1}:</Text>}
            <DiffView diff={diff} />
          </Box>
        );
      })}
    </Box>
  );
};

const CreateFilePrompt: FC<{ args: CreateFileArgs }> = ({ args }) => {
  // Show content as a diff with all lines added
  const diffLines = args.content
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green" bold>
          [CREATE]
        </Text>
        <Text> {args.path}</Text>
      </Box>
      <DiffView diff={diffLines} />
    </Box>
  );
};

const LLMAdvisory: FC<{ advisory: NonNullable<ApprovalDescriptor['llmAdvisory']> }> = ({ advisory }) => {
  const isSystem = advisory.source === 'system';
  const borderColor = isSystem ? 'red' : advisory.approved ? 'green' : 'yellow';
  const headerColor = isSystem ? 'red' : advisory.approved ? 'green' : 'yellow';
  const label = isSystem ? 'System Safety Check: BLOCKED ' : `AI Advisor: ${advisory.approved ? 'SAFE ' : 'CAUTION '}`;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} paddingY={0} borderStyle="round" borderColor={borderColor}>
      <Box>
        <Text color={headerColor} bold>
          {label}
        </Text>
        <Text color="#94a3b8"> ({isSystem ? 'automated heuristic' : advisory.model}) </Text>
      </Box>
      <Text italic color="#cbd5e1">
        {isSystem ? advisory.reasoning : `"${advisory.reasoning}"`}
      </Text>
    </Box>
  );
};

const ApprovalPrompt: FC<Props> = ({
  approval,
  onApprove,
  onReject,
  onCancel,
  onTypeAnswer,
  onNavigateQuestion,
  currentQuestionIndex = 0,
  waitingForAskUserAnswer = false,
}) => {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [selectedIndices, setSelectedIndices] = React.useState<Set<number>>(new Set());

  const isAskUser = approval.toolName === TOOL_NAME_ASK_USER;
  const askUserArgs = React.useMemo<AskUserArgs | null>(() => {
    if (!isAskUser) {
      return null;
    }

    try {
      return JSON.parse(approval.argumentsText) as AskUserArgs;
    } catch {
      return null;
    }
  }, [approval.argumentsText, isAskUser]);

  const questionsList = React.useMemo<QuestionItem[]>(() => {
    if (!askUserArgs || !Array.isArray(askUserArgs.questions) || askUserArgs.questions.length === 0) {
      return [];
    }
    return askUserArgs.questions;
  }, [askUserArgs]);

  const currentQuestionItem = questionsList[currentQuestionIndex] || questionsList[0];
  const isMultiSelect = !!currentQuestionItem?.is_multi_select;
  const askUserOptions = currentQuestionItem?.options ?? [];
  const askUserOptionLabels = askUserOptions.map((option) => option.label);
  const hasMultipleQuestions = questionsList.length > 1;

  const isUnsandboxedShellApproval = React.useMemo(() => {
    if (approval.toolName !== 'shell') {
      return false;
    }

    const parsedArgsText = parseShellApprovalArgs(approval.argumentsText);
    if (parsedArgsText?.sandbox === 'unsandboxed') {
      return true;
    }

    const rawInterruption =
      typeof approval.rawInterruption === 'object' && approval.rawInterruption !== null
        ? (approval.rawInterruption as Record<string, unknown>)
        : undefined;
    const parsedRaw = parseShellApprovalArgs(rawInterruption?.arguments);
    if (parsedRaw?.sandbox === 'unsandboxed') {
      return true;
    }

    return false;
  }, [approval.argumentsText, approval.rawInterruption, approval.toolName]);

  const isDockerHostControlApproval = React.useMemo(() => {
    if (approval.toolName !== 'shell') return false;
    // The producer already resolved this against the session's record of sandbox
    // Docker blocks; the prompt has no session identity, so it cannot re-derive
    // that half. Only the session-independent check is safe to evaluate here.
    if (approval.dockerHostControl) return true;

    const parsedArgsText = parseShellApprovalArgs(approval.argumentsText);
    const textCmd = parsedArgsText?.command ?? parsedArgsText?.commands;
    if (textCmd && requestsDockerHostControl(textCmd)) {
      return true;
    }

    const rawInterruption =
      typeof approval.rawInterruption === 'object' && approval.rawInterruption !== null
        ? (approval.rawInterruption as Record<string, unknown>)
        : undefined;
    const parsedRaw = parseShellApprovalArgs(rawInterruption?.arguments);
    const rawCmd = parsedRaw?.command ?? parsedRaw?.commands;
    if (rawCmd && requestsDockerHostControl(rawCmd)) {
      return true;
    }

    return false;
  }, [approval.argumentsText, approval.dockerHostControl, approval.rawInterruption, approval.toolName]);

  const isSandboxNetworkApproval = approval.toolName === 'sandbox_network_access';
  const deniedRead = approval.deniedRead;
  const isDeniedReadShell = !!deniedRead;
  // read_file/grep/glob share one session-scoped folder grant, so all three offer it.
  const isFolderReadApproval = supportsFolderSessionRead(approval.toolName);

  // The exact folder the session grant would cover, shown so the scope is not a guess.
  const folderReadGrantPath = React.useMemo(() => {
    if (!isFolderReadApproval) return null;
    try {
      const folder = resolveSessionReadFolder(approval.toolName, JSON.parse(approval.argumentsText));
      return folder ? folder.replace(os.homedir(), '~') : null;
    } catch {
      return null;
    }
  }, [approval.argumentsText, approval.toolName, isFolderReadApproval]);

  const deniedReadMenuItems = React.useMemo(() => {
    if (!deniedRead) return [];
    const items = ['Allow once', 'Deny'];
    if (!deniedRead.sensitive) {
      items.push('Allow and remember this path');
    }
    items.push('Run unsandboxed once');
    return items;
  }, [deniedRead]);

  const askUserMenuItems = React.useMemo(() => {
    if (isDockerHostControlApproval) {
      return ['Allow this command', 'Deny', 'Allow for this session', 'Always allow for this project'];
    }
    if (isSandboxNetworkApproval) {
      return ['Allow once', 'Deny', 'Allow host for this session', 'Always allow host for this project'];
    }
    if (!isAskUser && !isDeniedReadShell) {
      return isFolderReadApproval
        ? ['Allow once', 'Allow this folder for this session', 'Reject']
        : ['Approve', 'Reject'];
    }
    if (isDeniedReadShell) {
      return deniedReadMenuItems;
    }

    const items = isMultiSelect
      ? [...askUserOptionLabels, ASK_USER_SUBMIT_LABEL, ASK_USER_CUSTOM_ANSWER_LABEL, ASK_USER_DECLINE_LABEL]
      : [...askUserOptionLabels, ASK_USER_CUSTOM_ANSWER_LABEL, ASK_USER_DECLINE_LABEL];

    // Add navigation items only when there are multiple questions
    if (hasMultipleQuestions) {
      items.push(ASK_USER_PREV_QUESTION_LABEL);
      items.push(ASK_USER_NEXT_QUESTION_LABEL);
    }

    return items;
  }, [
    isAskUser,
    isMultiSelect,
    askUserOptionLabels,
    hasMultipleQuestions,
    deniedReadMenuItems,
    isDeniedReadShell,
    isFolderReadApproval,
    isDockerHostControlApproval,
    isSandboxNetworkApproval,
  ]);

  // reset selection when question/approval changes; cannot derive user-controlled arrow-key state from props
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset selection on question/approval change
    setSelectedIndex(0);
    setSelectedIndices(new Set());
  }, [currentQuestionIndex, approval.argumentsText, approval.toolName]);

  useInput((input, key) => {
    if (isAskUser && key.escape) {
      onCancel?.();
      return;
    }

    if (waitingForAskUserAnswer) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev === 0 ? askUserMenuItems.length - 1 : prev - 1));
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev === askUserMenuItems.length - 1 ? 0 : prev + 1));
    }

    // Spacebar for multi-select toggle
    if (input === ' ' && isMultiSelect) {
      // Only toggle if it's an actual option (not a navigation/submit/custom/decline item)
      if (selectedIndex < askUserOptions.length) {
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(selectedIndex)) {
            next.delete(selectedIndex);
          } else {
            next.add(selectedIndex);
          }
          return next;
        });
      }
    }

    if (key.return) {
      if (isDockerHostControlApproval) {
        const selected = askUserMenuItems[selectedIndex];
        if (selected === 'Deny') onReject();
        else if (selected === 'Allow this command') onApprove('docker-allow-once');
        else if (selected === 'Allow for this session') onApprove('docker-allow-session');
        else if (selected === 'Always allow for this project') onApprove('docker-allow-project');
        return;
      }
      if (isSandboxNetworkApproval) {
        const selected = askUserMenuItems[selectedIndex];
        if (selected === 'Deny') onReject();
        else if (selected === 'Allow once') onApprove('allow-once');
        else if (selected === 'Allow host for this session') onApprove('allow-session');
        else if (selected === 'Always allow host for this project') onApprove('allow-project');
        return;
      }
      if (isDeniedReadShell) {
        const selected = deniedReadMenuItems[selectedIndex];
        if (selected === 'Deny') {
          onReject();
        } else if (selected === 'Allow once') {
          onApprove('allow-once');
        } else if (selected === 'Allow and remember this path') {
          onApprove('allow-remember');
        } else if (selected === 'Run unsandboxed once') {
          onApprove('unsandboxed-once');
        }
        return;
      }
      if (isAskUser) {
        const selected = askUserMenuItems[selectedIndex];

        if (selected === ASK_USER_CUSTOM_ANSWER_LABEL) {
          onTypeAnswer?.();
        } else if (selected === ASK_USER_DECLINE_LABEL) {
          onApprove(ASK_USER_DECLINE_RESULT);
        } else if (selected === ASK_USER_PREV_QUESTION_LABEL) {
          onNavigateQuestion?.('prev');
        } else if (selected === ASK_USER_NEXT_QUESTION_LABEL) {
          onNavigateQuestion?.('next');
        } else if (isMultiSelect) {
          if (selected === ASK_USER_SUBMIT_LABEL) {
            const chosen = Array.from(selectedIndices)
              .map((idx) => askUserOptions[idx]?.label)
              .filter((label): label is string => typeof label === 'string');
            onApprove(JSON.stringify(chosen));
          } else if (selectedIndex < askUserOptions.length) {
            // Toggle checkbox for actual options
            setSelectedIndices((prev) => {
              const next = new Set(prev);
              if (next.has(selectedIndex)) {
                next.delete(selectedIndex);
              } else {
                next.add(selectedIndex);
              }
              return next;
            });
          }
        } else {
          onApprove(selected);
        }
      } else if (selectedIndex === 0) {
        onApprove();
      } else if (isFolderReadApproval && selectedIndex === 1) {
        onApprove(READ_FILE_SESSION_APPROVE_ANSWER);
      } else {
        onReject();
      }
    }

    if (isSandboxNetworkApproval) {
      if (input === 'y') {
        onApprove('allow-once');
      }
      if (input === 'n') {
        onReject();
      }
    } else if (!isAskUser && !isDeniedReadShell && !isDockerHostControlApproval) {
      if (input === 'y') {
        onApprove();
      }

      if (input === 'n') {
        onReject();
      }
    }
    if (isDeniedReadShell) {
      // Quick shortcuts for denied-read: y = allow once, n = deny.
      if (input === 'y') {
        onApprove('allow-once');
      }
      if (input === 'n') {
        onReject();
      }
    }
  });

  // Special handling for max turns exceeded prompt
  if (approval.toolName === 'max_turns_exceeded') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>
          {approval.argumentsText}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>Do you want to continue?</Text>
          <Box flexDirection="column" marginLeft={1}>
            <Text color={selectedIndex === 0 ? 'green' : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Yes</Text>
            <Text color={selectedIndex === 1 ? 'red' : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}No</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Try to parse and render arguments nicely based on tool type
  let content: React.ReactNode = (
    <Box marginTop={1}>
      <Text bold color="cyan">
        {approval.argumentsText}
      </Text>
    </Box>
  );

  if (approval.toolName === TOOL_NAME_APPLY_PATCH) {
    let parsedApplyPatch: ApplyPatchArgs | null = null;
    try {
      parsedApplyPatch = JSON.parse(approval.argumentsText);
    } catch {
      // Fall back to styled raw text if parsing fails
    }
    if (parsedApplyPatch) {
      content = <ApplyPatchPrompt args={parsedApplyPatch} />;
    }
  } else if (approval.toolName === 'shell') {
    const parsedShell = parseShellApprovalArgs(approval.argumentsText);
    content = parsedShell ? (
      <ShellPrompt args={parsedShell} />
    ) : (
      <ShellPrompt args={{ commands: approval.argumentsText }} />
    );
  } else if (approval.toolName === TOOL_NAME_SEARCH_REPLACE) {
    let parsedSearchReplace: SearchReplaceArgs | null = null;
    try {
      parsedSearchReplace = JSON.parse(approval.argumentsText);
    } catch {
      // Fall back to styled raw text if parsing fails
    }
    if (parsedSearchReplace) {
      content = <SearchReplacePrompt args={parsedSearchReplace} />;
    }
  } else if (approval.toolName === 'create_file') {
    let parsedCreateFile: CreateFileArgs | null = null;
    try {
      parsedCreateFile = JSON.parse(approval.argumentsText);
    } catch {
      // Fall back to styled raw text if parsing fails
    }
    if (parsedCreateFile) {
      content = <CreateFilePrompt args={parsedCreateFile} />;
    }
  } else if (isAskUser) {
    const questionText = currentQuestionItem?.question || 'Unknown question';
    const totalQuestions = questionsList.length;

    // Get the highlighted option and its description
    const highlightedMenuItem = askUserMenuItems[selectedIndex];
    const isOptionHighlighted = selectedIndex < askUserOptions.length;
    const highlightedOption = isOptionHighlighted ? askUserOptions[selectedIndex] : undefined;

    let highlightedDescription = highlightedOption?.description || '';

    // Provide default descriptions for built-in actions
    if (!highlightedDescription) {
      if (highlightedMenuItem === ASK_USER_CUSTOM_ANSWER_LABEL) {
        highlightedDescription = 'Type a custom write-in response.';
      } else if (highlightedMenuItem === ASK_USER_DECLINE_LABEL) {
        highlightedDescription = 'Decline to answer and skip this question.';
      } else if (highlightedMenuItem === ASK_USER_SUBMIT_LABEL) {
        highlightedDescription = 'Submit the selected options.';
      } else if (highlightedMenuItem === ASK_USER_PREV_QUESTION_LABEL) {
        highlightedDescription = 'Navigate to the previous question.';
      } else if (highlightedMenuItem === ASK_USER_NEXT_QUESTION_LABEL) {
        highlightedDescription = 'Navigate to the next question.';
      }
    }

    // Calculate dynamic left column width
    const leftColWidth = Math.max(
      ...askUserMenuItems.map((item, idx) => {
        const isOption = idx < askUserOptions.length;
        const isRecommended = idx === 0 && isOption;
        const isNavigation = item === ASK_USER_PREV_QUESTION_LABEL || item === ASK_USER_NEXT_QUESTION_LABEL;

        let label = item;
        if (item === ASK_USER_CUSTOM_ANSWER_LABEL || item === ASK_USER_DECLINE_LABEL || isNavigation) {
          // leave as is
        } else if (isMultiSelect && isOption) {
          const checkbox = selectedIndices.has(idx) ? '[x] ' : '[ ] ';
          label = checkbox + item + (isRecommended ? ' (recommended)' : '');
        } else {
          label = item + (isRecommended ? ' (recommended)' : '');
        }
        return label.length + 4; // Add padding/arrow prefix
      }),
      40, // minimum width
    );

    content = (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="yellow" paddingX={1} paddingY={0}>
          <Text color="yellow" bold>
            {totalQuestions > 1 ? `[Question ${currentQuestionIndex + 1}/${totalQuestions}] ` : ''}
            {questionText}
          </Text>
        </Box>
        {waitingForAskUserAnswer ? (
          <Box marginTop={1} marginLeft={1}>
            <Text color="cyan">❯ Type your custom answer in the prompt below...</Text>
          </Box>
        ) : (
          <Box flexDirection="row" width="100%" marginTop={1}>
            {/* Left Column: Menu Items */}
            <Box flexDirection="column" width={leftColWidth}>
              {askUserMenuItems.map((item, idx) => {
                const isOption = idx < askUserOptions.length;
                const isRecommended = idx === 0 && isOption;
                const isNavigation = item === ASK_USER_PREV_QUESTION_LABEL || item === ASK_USER_NEXT_QUESTION_LABEL;

                let label = item;
                if (item === ASK_USER_CUSTOM_ANSWER_LABEL || item === ASK_USER_DECLINE_LABEL) {
                  // leave as is
                } else if (isNavigation) {
                  // leave as is
                } else if (isMultiSelect && isOption) {
                  const checkbox = selectedIndices.has(idx) ? '[x] ' : '[ ] ';
                  label = checkbox + item + (isRecommended ? ' (recommended)' : '');
                } else {
                  label = item + (isRecommended ? ' (recommended)' : '');
                }

                const color = isNavigation
                  ? selectedIndex === idx
                    ? 'cyan'
                    : undefined
                  : selectedIndex === idx
                  ? item === ASK_USER_DECLINE_LABEL
                    ? 'red'
                    : item === ASK_USER_CUSTOM_ANSWER_LABEL
                    ? 'cyan'
                    : 'green'
                  : isRecommended
                  ? 'yellow'
                  : undefined;

                return (
                  <Text key={item} color={color}>
                    {selectedIndex === idx ? '❯ ' : '  '}
                    {label}
                  </Text>
                );
              })}
            </Box>

            {/* Right Column: Description of Highlighted Option */}
            <Box
              flexDirection="column"
              flexGrow={1}
              paddingLeft={2}
              borderStyle="single"
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              borderLeft={true}
              borderColor="#334155"
            >
              <Text bold color="yellow">
                HELP & DETAILS
              </Text>
              <Box marginTop={1}>
                {highlightedDescription ? (
                  <Text color="white">{highlightedDescription}</Text>
                ) : (
                  <Text color="#64748b" italic>
                    No description available.
                  </Text>
                )}
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  if (isDeniedReadShell && deniedRead) {
    // Compact the denied path for display (replace $HOME with ~).
    const displayPath = deniedRead.deniedPath.replace(os.homedir(), '~');
    const displaySuggestedParent = deniedRead.suggestedParent.replace(os.homedir(), '~');
    return (
      <Box flexDirection="column">
        <Text color="red" bold>
          Sandbox blocked read access:
        </Text>
        <Text color="red"> {displayPath}</Text>
        {content}
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          {deniedReadMenuItems.map((item, idx) => {
            const color = idx === 0 ? 'red' : item === 'Run unsandboxed once' ? 'yellow' : 'green';
            return (
              <Text key={item} color={selectedIndex === idx ? color : undefined}>
                {selectedIndex === idx ? '❯ ' : '  '}
                {item}
              </Text>
            );
          })}
        </Box>
        {!deniedRead.sensitive && (
          <Box marginTop={1}>
            <Text color="#64748b">
              "Allow and remember" persists this path for this project: {displaySuggestedParent}
            </Text>
          </Box>
        )}
        {deniedRead.sensitive && (
          <Box marginTop={1}>
            <Text color="#64748b">
              This is a sensitive path — "allow once" is available but remember is suppressed.
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {isDockerHostControlApproval ? (
          <Text bold color="red">
            Docker Host Control
          </Text>
        ) : (
          <>
            {approval.agentName}
            {isFolderReadApproval
              ? ' wants to read outside the workspace with '
              : isUnsandboxedShellApproval
              ? ' wants to run in unsandboxed mode: '
              : ' wants to run: '}
            <Text bold>{approval.toolName}</Text>
          </>
        )}
      </Text>
      {content}
      {isDockerHostControlApproval && (
        <Text color="red">
          This command can control your Docker daemon. It can bypass filesystem and network sandbox restrictions, mount
          host files, run privileged or persistent workloads, and is effectively equivalent to host access.
        </Text>
      )}
      {approval.llmAdvisory && <LLMAdvisory advisory={approval.llmAdvisory} />}
      {!isAskUser && !isDeniedReadShell && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {isDockerHostControlApproval
              ? 'Allow Docker host access?'
              : isFolderReadApproval
              ? 'Allow this read outside the workspace?'
              : 'Allow this action?'}
          </Text>
          <Box flexDirection="column" marginLeft={1}>
            {askUserMenuItems.map((item, index) => (
              <Text
                key={item}
                color={selectedIndex === index ? (item === 'Reject' || item === 'Deny' ? 'red' : 'green') : undefined}
              >
                {selectedIndex === index ? '❯ ' : '  '}
                {item}
              </Text>
            ))}
          </Box>
          {isFolderReadApproval && folderReadGrantPath && (
            <Box marginTop={1}>
              <Text color="#64748b">
                "Allow this folder" lets read_file, grep and glob read {folderReadGrantPath} for the rest of this
                session.
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

export default ApprovalPrompt;
