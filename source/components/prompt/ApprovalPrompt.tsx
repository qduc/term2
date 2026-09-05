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
import { asDisplayArray } from '../../utils/tool-args-display.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_ASK_USER, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { ASK_USER_CUSTOM_ANSWER_LABEL, ASK_USER_SUBMIT_LABEL } from '../../tools/agent/ask-user-constants.js';
import DiffView from '../layout/DiffView.js';
import { requestsDockerHostControl } from '../../utils/shell/sandbox/docker-host-control.js';
import {
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_DANGER,
  COLOR_SUCCESS,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
} from '../theme.js';
import { MenuFooter, SelectionMarker } from '../common/MenuContainer.js';

type Props = {
  approval: ApprovalDescriptor;
  onApprove: (answer?: string) => void;
  onReject: () => void;
  onCancel?: () => void;
  onTypeAnswer?: (initialAnswer?: string) => void;
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
  create_file: { label: 'CREATE', color: COLOR_SUCCESS },
  update_file: { label: 'UPDATE', color: COLOR_WARNING },
  delete_file: { label: 'DELETE', color: COLOR_DANGER },
};

const ApplyPatchPrompt: FC<{ args: ApplyPatchArgs }> = ({ args }) => {
  const op = operationLabels[args.type] || { label: args.type, color: COLOR_TEXT };

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
        <Text bold color={COLOR_ACCENT}>
          {cmd}
        </Text>
      </Box>
      {args.cwd && (
        <Box>
          <Text color={COLOR_TEXT_SUBTLE}>Cwd: {args.cwd}</Text>
        </Box>
      )}
      {args.timeout_ms && (
        <Box>
          <Text color={COLOR_TEXT_SUBTLE}>Timeout: {args.timeout_ms}ms</Text>
        </Box>
      )}
      {args.max_output_length && (
        <Box>
          <Text color={COLOR_TEXT_SUBTLE}>Max output: {args.max_output_length} chars</Text>
        </Box>
      )}
    </Box>
  );
};

const SearchReplacePrompt: FC<{ args: SearchReplaceArgs }> = ({ args }) => {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR_WARNING} bold>
          [SEARCH & REPLACE]
        </Text>
        <Text> {args.path}</Text>
      </Box>
      {asDisplayArray<SearchReplaceArgs['replacements'][number]>(args.replacements).map((rep, idx, all) => {
        const diff = generateDiff(rep?.search_content, rep?.replace_content);
        return (
          <Box key={idx} flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
            {all.length > 1 && <Text color={COLOR_TEXT_SUBTLE}>Replacement #{idx + 1}:</Text>}
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
        <Text color={COLOR_SUCCESS} bold>
          [CREATE]
        </Text>
        <Text> {args.path}</Text>
      </Box>
      <DiffView diff={diffLines} />
    </Box>
  );
};

type SafetyFindingLevel = 'RED' | 'YELLOW' | 'GREEN';

const SAFETY_FINDING_COLORS: Record<SafetyFindingLevel, string> = {
  RED: COLOR_DANGER,
  YELLOW: COLOR_WARNING,
  GREEN: COLOR_SUCCESS,
};

type ParsedSystemSafetyReasoning = {
  findings: { level: SafetyFindingLevel; detail: string }[];
  modelAdvisory?: string;
};

/**
 * The safety evaluator deliberately keeps its advisory as plain text for
 * transport compatibility. Recover the structured severity markers only at
 * this presentation boundary so mixed findings remain scannable in a narrow
 * terminal.
 */
function parseSystemSafetyReasoning(reasoning: string): ParsedSystemSafetyReasoning | null {
  const modelAdvisoryMarker = '\n\nModel advisory:';
  const modelAdvisoryIndex = reasoning.indexOf(modelAdvisoryMarker);
  const safetyText = modelAdvisoryIndex >= 0 ? reasoning.slice(0, modelAdvisoryIndex) : reasoning;
  const modelAdvisory =
    modelAdvisoryIndex >= 0 ? reasoning.slice(modelAdvisoryIndex + modelAdvisoryMarker.length).trim() : undefined;
  const match = safetyText.match(
    /^Blocked by safety heuristics \(RED\): (.*)\. Manual approval is strictly required\.$/s,
  );
  if (!match) return null;

  const findings: ParsedSystemSafetyReasoning['findings'] = [];
  const findingPattern = /(?:^|;\s*)((?:RED|YELLOW|GREEN)):\s*(.*?)(?=;\s*(?:RED|YELLOW|GREEN):|$)/g;
  for (const finding of match[1].matchAll(findingPattern)) {
    findings.push({ level: finding[1] as SafetyFindingLevel, detail: finding[2] });
  }

  // A RED result can have no reason text if the classifier only returns its
  // status. Still make the blocking status visible instead of rendering an
  // empty findings section.
  if (findings.length === 0) {
    findings.push({ level: 'RED', detail: match[1] });
  }

  return { findings, ...(modelAdvisory ? { modelAdvisory } : {}) };
}

const LLMAdvisory: FC<{ advisory: NonNullable<ApprovalDescriptor['llmAdvisory']> }> = ({ advisory }) => {
  const isSystem = advisory.source === 'system';
  const advisoryColor = isSystem ? COLOR_DANGER : advisory.approved ? COLOR_SUCCESS : COLOR_WARNING;
  const borderColor = advisoryColor;
  const headerColor = advisoryColor;
  const label = isSystem ? 'System Safety Check: BLOCKED ' : `AI Advisor: ${advisory.approved ? 'SAFE ' : 'CAUTION '}`;
  const parsedSystemReasoning = isSystem ? parseSystemSafetyReasoning(advisory.reasoning) : null;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} paddingY={0} borderStyle="round" borderColor={borderColor}>
      <Box>
        <Text color={headerColor} bold>
          {label}
        </Text>
        <Text color={COLOR_TEXT_MUTED}> ({isSystem ? 'automated heuristic' : advisory.model}) </Text>
      </Box>
      {parsedSystemReasoning ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={COLOR_TEXT_MUTED}>
            Heuristic findings:
          </Text>
          <Box flexDirection="column" marginLeft={1}>
            {parsedSystemReasoning.findings.map(({ level, detail }, index) => (
              <Box key={`${level}-${detail}-${index}`}>
                <Text color={SAFETY_FINDING_COLORS[level]} bold>
                  {`${level}:`.padEnd(8)}
                </Text>
                <Text color={COLOR_TEXT_MUTED}>{detail}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={COLOR_TEXT_MUTED}>Manual approval is strictly required.</Text>
          </Box>
          {parsedSystemReasoning.modelAdvisory && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={COLOR_TEXT_MUTED}>
                Model advisory:
              </Text>
              <Text italic color={COLOR_TEXT_MUTED}>
                {parsedSystemReasoning.modelAdvisory}
              </Text>
            </Box>
          )}
        </Box>
      ) : (
        <Text italic color={COLOR_TEXT_MUTED}>
          {isSystem ? advisory.reasoning : `"${advisory.reasoning}"`}
        </Text>
      )}
    </Box>
  );
};

/**
 * The shared two-pane approval shape: an option list on the left, and a
 * description of the highlighted option on the right. Previously only the
 * ask_user branch explained its options; every other approval was a bare
 * list, so a reviewer had to already know what "Allow this folder for this
 * session" does. Reusing one layout means every approval gets that
 * explanation for free.
 */
const TwoPaneApprovalLayout: FC<{
  leftWidth: number;
  left: React.ReactNode;
  rightTitle: React.ReactNode;
  rightDescription: React.ReactNode;
}> = ({ leftWidth, left, rightTitle, rightDescription }) => (
  <Box flexDirection="row" width="100%" marginTop={1}>
    <Box flexDirection="column" width={leftWidth} flexShrink={0} flexGrow={0}>
      {left}
    </Box>
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      paddingLeft={2}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft={true}
      borderColor={COLOR_BORDER}
    >
      <Text bold color={COLOR_WARNING}>
        {rightTitle}
      </Text>
      <Box marginTop={1}>
        {rightDescription ? (
          <Text color={COLOR_TEXT}>{rightDescription}</Text>
        ) : (
          <Text color={COLOR_TEXT_SUBTLE} italic>
            No description available.
          </Text>
        )}
      </Box>
    </Box>
  </Box>
);

/**
 * Descriptions for the standard (non-ask_user) approval menus. Several
 * contexts reuse the same label ("Allow once", "Reject") for different scope,
 * so the description depends on which approval is showing, not just the
 * label text.
 */
function describeStandardApprovalOption(
  item: string,
  ctx: {
    isDockerHostControlApproval: boolean;
    isSandboxNetworkApproval: boolean;
    isOutsideWorkspaceEdit: boolean;
    isFolderReadApproval: boolean;
    folderReadGrantPath: string | null;
  },
): string {
  if (ctx.isDockerHostControlApproval) {
    switch (item) {
      case 'Allow this command':
        return 'Run this Docker host control command once.';
      case 'Deny':
        return 'Block this command.';
      case 'Allow for this session':
        return 'Allow Docker host control commands for the rest of this session without asking again.';
      case 'Always allow for this project':
        return 'Always allow Docker host control commands in this project, persisted across sessions.';
    }
  }
  if (ctx.isSandboxNetworkApproval) {
    switch (item) {
      case 'Allow once':
        return 'Allow network access to this host for this command only.';
      case 'Deny':
        return 'Block network access to this host.';
      case 'Allow host for this session':
        return 'Allow this host for the rest of this session.';
      case 'Always allow host for this project':
        return 'Always allow this host in this project, persisted across sessions.';
    }
  }
  if (ctx.isOutsideWorkspaceEdit) {
    switch (item) {
      case 'Allow once':
        return 'Allow this edit this one time.';
      case 'Allow this file for this session':
        return 'Allow edits to this exact file for the rest of this session.';
      case 'Allow this folder for this session':
        return 'Allow edits anywhere under this folder for the rest of this session.';
      case 'Reject':
        return 'Deny this edit.';
    }
  }
  if (ctx.isFolderReadApproval) {
    switch (item) {
      case 'Allow once':
        return 'Allow this read this one time.';
      case 'Allow this folder for this session':
        return ctx.folderReadGrantPath
          ? `Allow read_file, grep, and glob to read ${ctx.folderReadGrantPath} for the rest of this session.`
          : 'Allow read_file, grep, and glob to read this folder for the rest of this session.';
      case 'Reject':
        return 'Deny this read.';
    }
  }
  switch (item) {
    case 'Approve':
      return 'Allow this tool call.';
    case 'Reject':
      return 'Deny this tool call.';
  }
  return '';
}

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
  const isOutsideWorkspaceEdit = Boolean(approval.outsideWorkspaceEdit);

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
      return isOutsideWorkspaceEdit
        ? ['Allow once', 'Allow this file for this session', 'Allow this folder for this session', 'Reject']
        : isFolderReadApproval
        ? ['Allow once', 'Allow this folder for this session', 'Reject']
        : ['Approve', 'Reject'];
    }
    if (isDeniedReadShell) {
      return deniedReadMenuItems;
    }

    return isMultiSelect
      ? [...askUserOptionLabels, ASK_USER_SUBMIT_LABEL, ASK_USER_CUSTOM_ANSWER_LABEL]
      : [...askUserOptionLabels, ASK_USER_CUSTOM_ANSWER_LABEL];
  }, [
    isAskUser,
    isMultiSelect,
    askUserOptionLabels,
    deniedReadMenuItems,
    isDeniedReadShell,
    isFolderReadApproval,
    isDockerHostControlApproval,
    isSandboxNetworkApproval,
    isOutsideWorkspaceEdit,
  ]);

  // reset selection when question/approval changes; cannot derive user-controlled arrow-key state from props
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset selection on question/approval change
    setSelectedIndex(0);
    setSelectedIndices(new Set());
  }, [currentQuestionIndex, approval.argumentsText, approval.toolName]);

  useInput((input, key) => {
    if (key.escape) {
      // Escape cancels/interrupts the pending action for every approval type.
      // The parent routes it (ask_user → graceful cancel; anything else →
      // interrupt the turn). Kept ahead of the `waitingForAskUserAnswer` guard
      // to match the historical ask_user Esc behavior exactly.
      onCancel?.();
      return;
    }

    if (waitingForAskUserAnswer) {
      return;
    }

    if (isAskUser) {
      // Question navigation with p / n or left / right arrow keys
      if (hasMultipleQuestions) {
        if (input.toLowerCase() === 'p' || key.leftArrow) {
          onNavigateQuestion?.('prev');
          return;
        }
        if (input.toLowerCase() === 'n' || key.rightArrow) {
          onNavigateQuestion?.('next');
          return;
        }
      }

      // Direct number key selection: '1'..'9'
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= askUserMenuItems.length && String(num) === input) {
        const targetIndex = num - 1;
        const selected = askUserMenuItems[targetIndex];

        if (selected === ASK_USER_CUSTOM_ANSWER_LABEL) {
          onTypeAnswer?.();
          return;
        }

        if (isMultiSelect) {
          if (selected === ASK_USER_SUBMIT_LABEL) {
            const chosen = Array.from(selectedIndices)
              .map((idx) => askUserOptions[idx]?.label)
              .filter((label): label is string => typeof label === 'string');
            onApprove(JSON.stringify(chosen));
            return;
          }
          if (targetIndex < askUserOptions.length) {
            setSelectedIndices((prev) => {
              const next = new Set(prev);
              if (next.has(targetIndex)) {
                next.delete(targetIndex);
              } else {
                next.add(targetIndex);
              }
              return next;
            });
            setSelectedIndex(targetIndex);
            return;
          }
        } else {
          if (targetIndex < askUserOptions.length) {
            onApprove(askUserOptions[targetIndex]?.label);
            return;
          }
        }
      }
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev === 0 ? askUserMenuItems.length - 1 : prev - 1));
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev === askUserMenuItems.length - 1 ? 0 : prev + 1));
    }

    // Spacebar for multi-select toggle
    if (input === ' ' && isMultiSelect) {
      // Only toggle if it's an actual option (not submit/custom item)
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
      } else if (isOutsideWorkspaceEdit && selectedIndex === 1) {
        onApprove('allow-edit-file-session');
      } else if (isOutsideWorkspaceEdit && selectedIndex === 2) {
        onApprove('allow-edit-folder-session');
      } else {
        onReject();
      }
    }
  });

  // A system check-in, not a tool approval: continue or stop, no denial reason.
  if (approval.checkIn) {
    return (
      <Box flexDirection="column">
        <Text color={COLOR_WARNING} bold>
          {approval.argumentsText}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {approval.checkIn === 'run_budget'
              ? 'Continue with one finite budget extension, or stop?'
              : 'Continue with one finite extension, or stop?'}
          </Text>
          <Box flexDirection="column" marginLeft={1}>
            <Box>
              <SelectionMarker selected={selectedIndex === 0} />
              <Text color={selectedIndex === 0 ? COLOR_SUCCESS : undefined}>Continue</Text>
            </Box>
            <Box>
              <SelectionMarker selected={selectedIndex === 1} />
              <Text color={selectedIndex === 1 ? COLOR_DANGER : undefined}>Stop</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // Try to parse and render arguments nicely based on tool type
  let content: React.ReactNode = (
    <Box marginTop={1}>
      <Text bold color={COLOR_ACCENT}>
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
        highlightedDescription =
          'Discuss or provide a custom response. The agent will respond and can re-ask if needed.';
      } else if (highlightedMenuItem === ASK_USER_SUBMIT_LABEL) {
        highlightedDescription = 'Submit the selected options.';
      }
    }

    const rightPaneTitle = isOptionHighlighted
      ? highlightedOption?.label ?? 'Option'
      : highlightedMenuItem === ASK_USER_CUSTOM_ANSWER_LABEL
      ? 'Something else…'
      : highlightedMenuItem === ASK_USER_SUBMIT_LABEL
      ? 'Submit answer'
      : highlightedMenuItem ?? 'Details';

    // Calculate dynamic left column width
    const leftColWidth = Math.max(
      ...askUserMenuItems.map((item, idx) => {
        const isOption = idx < askUserOptions.length;
        let label = `${idx + 1}. ${item}`;
        if (isMultiSelect && isOption) {
          label = `${idx + 1}. [x] ${item}`;
        }
        return label.length + 6; // Add padding/gutter prefix
      }),
      36, // minimum width
    );

    const askUserFooterHints: [string, string][] = [
      [
        isMultiSelect ? `1-${askUserOptions.length}` : `1-${askUserMenuItems.length}`,
        isMultiSelect ? 'toggle' : 'select',
      ],
      ...(hasMultipleQuestions ? ([['p/n', 'prev/next question']] as [string, string][]) : []),
      ...(isMultiSelect ? ([['space', 'toggle']] as [string, string][]) : []),
      ['⏎', isMultiSelect ? 'submit' : 'confirm'],
      ['esc', 'cancel'],
    ];

    content = (
      <Box flexDirection="column">
        {totalQuestions > 1 && (
          <Box marginLeft={1}>
            <Text color={COLOR_TEXT_SUBTLE}>
              Question {currentQuestionIndex + 1} of {totalQuestions}
            </Text>
          </Box>
        )}
        <Box borderStyle="round" borderColor={COLOR_WARNING} paddingX={1} paddingY={0}>
          <Text color={COLOR_WARNING} bold>
            {questionText}
          </Text>
        </Box>
        {waitingForAskUserAnswer && (
          <Box marginTop={1} marginLeft={1}>
            <Text color={COLOR_ACCENT}>❯ Type your custom answer in the prompt below...</Text>
          </Box>
        )}
        <TwoPaneApprovalLayout
          leftWidth={leftColWidth}
          left={askUserMenuItems.map((item, idx) => {
            const isOption = idx < askUserOptions.length;
            const isRecommended = idx === 0 && isOption;
            const isSelected = selectedIndex === idx;

            let checkbox = '';
            if (isMultiSelect && isOption) {
              checkbox = selectedIndices.has(idx) ? '[x] ' : '[ ] ';
            }

            const color = isSelected
              ? item === ASK_USER_CUSTOM_ANSWER_LABEL
                ? COLOR_ACCENT
                : COLOR_SUCCESS
              : undefined;

            return (
              <Box key={item} flexDirection="row" width="100%">
                <SelectionMarker selected={isSelected} />
                <Box width={2} flexShrink={0}>
                  <Text color={COLOR_TEXT_SUBTLE} dimColor>
                    {isRecommended ? '★' : ' '}
                  </Text>
                </Box>
                <Box flexDirection="row" flexShrink={1} flexWrap="wrap">
                  <Text color={color} bold={isSelected}>
                    {idx + 1}. {checkbox}
                    {item}
                  </Text>
                </Box>
              </Box>
            );
          })}
          rightTitle={rightPaneTitle}
          rightDescription={highlightedDescription}
        />
        <Box marginTop={1} marginLeft={1}>
          <MenuFooter hints={askUserFooterHints} />
        </Box>
      </Box>
    );
  }

  if (isDeniedReadShell && deniedRead) {
    // Compact the denied path for display (replace $HOME with ~).
    const displayPath = deniedRead.deniedPath.replace(os.homedir(), '~');
    const displaySuggestedParent = deniedRead.suggestedParent.replace(os.homedir(), '~');
    return (
      <Box flexDirection="column">
        <Text color={COLOR_DANGER} bold>
          Sandbox blocked read access:
        </Text>
        <Text color={COLOR_DANGER}> {displayPath}</Text>
        {/* Red left border, not just red text: this approval can grant access outside
            the workspace, so its shape should read as risky before the words are read. */}
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeft={true}
          borderColor={COLOR_DANGER}
          paddingLeft={1}
          marginTop={1}
        >
          {content}
          <Box flexDirection="column" marginTop={1}>
            {deniedReadMenuItems.map((item, idx) => {
              const color = idx === 0 ? COLOR_DANGER : item === 'Run unsandboxed once' ? COLOR_WARNING : COLOR_SUCCESS;
              return (
                <Box key={item}>
                  <SelectionMarker selected={selectedIndex === idx} />
                  <Text color={selectedIndex === idx ? color : undefined}>{item}</Text>
                </Box>
              );
            })}
          </Box>
          {!deniedRead.sensitive && (
            <Box marginTop={1}>
              <Text color={COLOR_TEXT_SUBTLE}>
                "Allow and remember" persists this path for this project: {displaySuggestedParent}
              </Text>
            </Box>
          )}
          {deniedRead.sensitive && (
            <Box marginTop={1}>
              <Text color={COLOR_TEXT_SUBTLE}>
                This is a sensitive path — "allow once" is available but remember is suppressed.
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // Left column width scales with the longest option label so the description
  // pane's border lands in the same place regardless of which approval this is.
  const plainApprovalLeftWidth = Math.max(...askUserMenuItems.map((item) => item.length + 4), 20);

  const plainApprovalSection = !isAskUser && !isDeniedReadShell && (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {isDockerHostControlApproval
          ? 'Allow Docker host access?'
          : isOutsideWorkspaceEdit
          ? 'Allow permission to edit this file outside the workspace?'
          : isFolderReadApproval
          ? 'Allow this read outside the workspace?'
          : 'Allow this action?'}
      </Text>
      <TwoPaneApprovalLayout
        leftWidth={plainApprovalLeftWidth}
        left={askUserMenuItems.map((item, index) => {
          const isSelected = selectedIndex === index;
          const isDangerLabel = item === 'Reject' || item === 'Deny';
          return (
            <Box key={item}>
              <SelectionMarker selected={isSelected} />
              <Text color={isSelected ? (isDangerLabel ? COLOR_DANGER : COLOR_SUCCESS) : undefined}>{item}</Text>
            </Box>
          );
        })}
        rightTitle={askUserMenuItems[selectedIndex] ?? 'Option'}
        rightDescription={describeStandardApprovalOption(askUserMenuItems[selectedIndex] ?? '', {
          isDockerHostControlApproval,
          isSandboxNetworkApproval,
          isOutsideWorkspaceEdit,
          isFolderReadApproval,
          folderReadGrantPath,
        })}
      />
      {isFolderReadApproval && folderReadGrantPath && (
        <Box marginTop={1}>
          <Text color={COLOR_TEXT_SUBTLE}>
            "Allow this folder" lets read_file, grep and glob read {folderReadGrantPath} for the rest of this session.
          </Text>
        </Box>
      )}
      {isOutsideWorkspaceEdit && approval.outsideWorkspaceEdit && (
        <Box marginTop={1}>
          <Text color={COLOR_TEXT_SUBTLE}>
            File scope permits only {approval.outsideWorkspaceEdit.path}; folder scope permits edits beneath{' '}
            {approval.outsideWorkspaceEdit.folder} for this session.
          </Text>
        </Box>
      )}
    </Box>
  );

  const bodyContent = (
    <>
      {content}
      {isDockerHostControlApproval && (
        <Text color={COLOR_DANGER}>
          This command can control your Docker daemon. It can bypass filesystem and network sandbox restrictions, mount
          host files, run privileged or persistent workloads, and is effectively equivalent to host access.
        </Text>
      )}
      {approval.llmAdvisory && <LLMAdvisory advisory={approval.llmAdvisory} />}
      {plainApprovalSection}
    </>
  );

  return (
    <Box flexDirection="column">
      <Text color={COLOR_WARNING}>
        {isDockerHostControlApproval ? (
          <Text bold color={COLOR_DANGER}>
            Docker Host Control
          </Text>
        ) : (
          <>
            {approval.agentName}
            {isOutsideWorkspaceEdit
              ? ' is requesting permission to edit a file outside the workspace with '
              : isFolderReadApproval
              ? ' wants to read outside the workspace with '
              : isUnsandboxedShellApproval
              ? ' wants to run in unsandboxed mode: '
              : ' wants to run: '}
            <Text bold>{approval.toolName}</Text>
          </>
        )}
      </Text>
      {isDockerHostControlApproval ? (
        // Red left border, not just red text: Docker host control is the single
        // riskiest approval this app shows, and should be recognizable by shape
        // even before the words are read.
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeft={true}
          borderColor={COLOR_DANGER}
          paddingLeft={1}
          marginTop={1}
        >
          {bodyContent}
        </Box>
      ) : (
        bodyContent
      )}
    </Box>
  );
};

export default ApprovalPrompt;
