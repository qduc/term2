import React, { FC } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
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

type Props = {
  approval: ApprovalDescriptor;
  onApprove: (answer?: string) => void;
  onReject: () => void;
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
  commands: string;
  timeout_ms?: number;
  max_output_length?: number;
};

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
  const cmd = (args as any).command ?? args.commands ?? '';
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text bold color="cyan">
          {cmd}
        </Text>
      </Box>
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

  const askUserMenuItems = React.useMemo(() => {
    if (!isAskUser) {
      return ['Approve', 'Reject'];
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
  }, [isAskUser, isMultiSelect, askUserOptions, hasMultipleQuestions]);

  React.useEffect(() => {
    setSelectedIndex(0);
    setSelectedIndices(new Set());
  }, [currentQuestionIndex, approval.argumentsText, approval.toolName]);

  useInput((input, key) => {
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
      } else {
        onReject();
      }
    }

    if (!isAskUser) {
      if (input === 'y') {
        onApprove();
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
    try {
      const args: ApplyPatchArgs = JSON.parse(approval.argumentsText);
      content = <ApplyPatchPrompt args={args} />;
    } catch {
      // Fall back to styled raw text if parsing fails
    }
  } else if (approval.toolName === 'shell') {
    try {
      const args: ShellArgs = JSON.parse(approval.argumentsText);
      content = <ShellPrompt args={args} />;
    } catch {
      // Fall back to ShellPrompt with raw command string if parsing fails
      content = <ShellPrompt args={{ commands: approval.argumentsText }} />;
    }
  } else if (approval.toolName === TOOL_NAME_SEARCH_REPLACE) {
    try {
      const args: SearchReplaceArgs = JSON.parse(approval.argumentsText);
      content = <SearchReplacePrompt args={args} />;
    } catch {
      // Fall back to styled raw text if parsing fails
    }
  } else if (approval.toolName === 'create_file') {
    try {
      const args: CreateFileArgs = JSON.parse(approval.argumentsText);
      content = <CreateFilePrompt args={args} />;
    } catch {
      // Fall back to styled raw text if parsing fails
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

  return (
    <Box flexDirection="column">
      <Text color="yellow">
        {approval.agentName} wants to run: <Text bold>{approval.toolName}</Text>
      </Text>
      {content}
      {approval.llmAdvisory && <LLMAdvisory advisory={approval.llmAdvisory} />}
      {!isAskUser && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Allow this action?</Text>
          <Box flexDirection="column" marginLeft={1}>
            <Text color={selectedIndex === 0 ? 'green' : undefined}>{selectedIndex === 0 ? '❯ ' : '  '}Approve</Text>
            <Text color={selectedIndex === 1 ? 'red' : undefined}>{selectedIndex === 1 ? '❯ ' : '  '}Reject</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default ApprovalPrompt;
