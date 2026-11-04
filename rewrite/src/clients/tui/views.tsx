import { terminalTextWidth, truncateTerminalText } from './task-manager.js';
import { useTerminalSize } from './terminal.js';
import React, { useEffect, useRef, useState } from 'react';
import { StreamingSpeedTracker } from './presentation/utils/streaming/streaming-speed-tracker.js';
import { Box, Text } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import MarkdownRenderer from './presentation/components/MarkdownRenderer.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import type { Message, ToolView, TuiState } from './state.js';
import { ToolCall } from './tool-view.js';
import CommandMessage from './presentation/components/message/CommandMessage.js';
import { groupTools, shownOrder, ToolGroupRow } from './tool-groups.js';

/** Render mixed history only in the authoritative wire order; separate items with unknown order. */
export function Transcript({
  state,
  messages,
  columns,
  live,
  expanded = false,
  staticRow = false,
}: {
  readonly state: TuiState;
  readonly messages: readonly Message[];
  readonly columns: number;
  readonly live: boolean;
  /** Show every tool's output, not only failures. */
  readonly expanded?: boolean;
  readonly staticRow?: boolean;
}): React.ReactElement {
  const { UserMessage, AssistantFrame, assistantGutter } = useSkin();
  const theme = useTheme();
  const width = Math.max(1, columns - 2 - assistantGutter);
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const toolById = new Map((live ? state.tools : []).map((tool) => [tool.id, tool]));
  // Legacy folds runs of tool calls only in concise display; a committed row is its own, already grouped, run.
  const groups =
    expanded || !state.timeline ? new Map() : groupTools(state.timeline, state.tools, false, state.toolShownAt);
  const usedMessages = new Set<string>();
  const usedTools = new Set<string>();
  const renderMessage = (message: Message) =>
    message.role === 'user' ? (
      // Legacy MessageList: a user row sits two rows below what precedes it.
      <Box key={`message:${message.id}`} marginTop={2} paddingLeft={2}>
        <Box flexDirection="column">
          <UserMessage text={message.text} />
          {message.attachments?.length ? (
            <Text color={theme.textSubtle}>
              [{message.attachments.length} {message.attachments.length === 1 ? 'image' : 'images'} attached]
            </Text>
          ) : null}
        </Box>
      </Box>
    ) : message.localShell ? (
      <Box key={`message:${message.id}`} marginTop={1} paddingLeft={2}>
        <CommandMessage
          command={message.localShell.command}
          output={message.localShell.output}
          status={message.localShell.success ? 'completed' : 'failed'}
          success={message.localShell.success}
          {...(message.localShell.failureReason ? { failureReason: message.localShell.failureReason } : {})}
          toolName="shell"
          displayMode={expanded ? 'standard' : 'concise'}
        />
      </Box>
    ) : message.localHelp === true ? (
      // Legacy shows /help as a system message: reasoning colour inside MessageList's paddingX 2.
      <Box key={`message:${message.id}`} marginTop={1} paddingX={2}>
        <Text color={theme.reasoning}>{message.text}</Text>
      </Box>
    ) : message.role === 'assistant' ? (
      <Box key={`message:${message.id}`} flexDirection="column" marginTop={1} paddingLeft={2}>
        <AssistantFrame kind="answer">
          <MarkdownRenderer maxWidth={width}>{message.text}</MarkdownRenderer>
        </AssistantFrame>
        {/* Legacy's stopProcessingWithNotice: a system row (reasoning colour) one row below the reply. */}
        {message.interrupted ? (
          <Box marginTop={1}>
            <Text color={theme.reasoning}>Stopped</Text>
          </Box>
        ) : null}
      </Box>
    ) : (
      <Box key={`message:${message.id}`} marginTop={1}>
        <Text color={message.error ? theme.danger : theme.textSubtle}>
          {message.role}: {message.text}
        </Text>
      </Box>
    );
  const ordered =
    (state.timeline && shownOrder(state.timeline, state.toolShownAt))?.flatMap<React.ReactNode>((item) => {
      if (item.kind === 'message') {
        const message = messageById.get(item.id);
        if (!message || usedMessages.has(item.id)) return [];
        usedMessages.add(item.id);
        return [renderMessage(message)];
      }
      const tool = toolById.get(item.id);
      if (!tool || usedTools.has(item.id)) return [];
      usedTools.add(item.id);
      if (undecided(state, tool)) return [];
      const group = groups.get(tool.id);
      if (group === null) return [];
      if (group !== undefined)
        return [
          <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
            <ToolGroupRow group={group} />
          </Box>,
        ];
      return [
        <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
          <ToolCall
            tool={tool}
            expanded={expanded}
            awaitingDecision={live && state.interactions.length > 0}
            startedAt={
              state.tasks.find((task) => task.wire?.parentExecutionId === tool.id && task.wire.kind === 'shell')?.wire
                ?.startedAt
            }
          />
        </Box>,
      ];
    }) ?? [];
  const remainingMessages = messages.filter((message) => !usedMessages.has(message.id));
  const remainingTools = live ? state.tools.filter((tool) => !usedTools.has(tool.id) && !undecided(state, tool)) : [];
  return (
    <Box flexDirection="column" paddingRight={2} paddingBottom={staticRow ? 0 : 1}>
      {ordered}
      {state.timeline && (remainingMessages.length || remainingTools.length) ? (
        <Text color={theme.textSubtle}>Additional items (order unavailable)</Text>
      ) : null}
      {remainingMessages.map(renderMessage)}
      {live &&
        Object.entries(state.reasoning).map(([id, text]) => (
          <Box key={`reasoning:${id}`} marginTop={1} paddingLeft={2}>
            <AssistantFrame kind="reasoning">
              <MarkdownRenderer defaultColor={theme.reasoning} maxWidth={width}>
                {text}
              </MarkdownRenderer>
            </AssistantFrame>
          </Box>
        ))}
      {live &&
        Object.entries(state.drafts).map(([id, text]) => (
          <Box key={`draft:${id}`} marginTop={1} paddingLeft={2}>
            <AssistantFrame kind="answer">
              <MarkdownRenderer maxWidth={width}>{text}</MarkdownRenderer>
            </AssistantFrame>
          </Box>
        ))}
      {!state.timeline && remainingTools.length ? (
        <Text color={theme.textSubtle}>Tool executions (transcript order unavailable)</Text>
      ) : null}
      {remainingTools.map((tool) => (
        <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
          <ToolCall
            tool={tool}
            expanded={expanded}
            awaitingDecision={live && state.interactions.length > 0}
            startedAt={
              state.tasks.find((task) => task.wire?.parentExecutionId === tool.id && task.wire.kind === 'shell')?.wire
                ?.startedAt
            }
          />
        </Box>
      ))}
    </Box>
  );
}

/**
 * Legacy's liveStreamingSpeed: the rate measured from displayed stream deltas while a request streams. It resets
 * when a tool runs or the stream restarts, and is gone when the turn ends; the working line and the status bar
 * both show it.
 */
export function useLiveStreamingSpeed(state: TuiState): number | null {
  const tracker = useRef(new StreamingSpeedTracker());
  const previous = useRef('');
  const turn = useRef<string | null>(null);
  const liveRate = useRef<number | null>(null);
  const text = [...Object.values(state.reasoning), ...Object.values(state.drafts)].join('');
  const toolRunning = state.tools.some((tool) => tool.status === 'running' || tool.status === 'pending');
  if (turn.current !== state.activeTurnId || toolRunning || !text.startsWith(previous.current)) {
    turn.current = state.activeTurnId;
    tracker.current.reset();
    previous.current = '';
    liveRate.current = null;
  }
  if (state.activeTurnId && !toolRunning && text.length > previous.current.length) {
    tracker.current.recordDelta(text.slice(previous.current.length));
    liveRate.current = tracker.current.getLiveTps() ?? liveRate.current;
    previous.current = text;
  }
  return state.activeTurnId && !toolRunning ? liveRate.current : null;
}

/** The working line; its rate is the session's live streaming speed. */
function StreamingStatus({
  state,
  liveTps,
}: {
  readonly state: TuiState;
  readonly liveTps: number | null;
}): React.ReactElement {
  const { WorkingIndicator } = useSkin();
  const start = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const [dotCount, setDotCount] = useState(1);
  // Legacy names the latest streamed tool call, so with parallel calls the last one in flight is the one shown.
  const activeTool = [...state.tools].reverse().find((tool) => tool.status === 'running' || tool.status === 'pending');
  const toolRunning = activeTool != null;
  const rate = toolRunning ? null : liveTps;
  const phase = toolRunning ? 'tool_call' : rate != null && rate > 0 ? 'generating' : 'processing';
  const stepKey = phase === 'tool_call' ? `tool_call:${activeTool?.name ?? ''}` : phase;
  // Like legacy, the clock restarts with each step, so its seconds tick from the step's start.
  useEffect(() => {
    start.current = Date.now();
    setNow(start.current);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stepKey]);
  useEffect(() => {
    const timer = setInterval(() => setDotCount((previous) => (previous === 3 ? 1 : previous + 1)), 800);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - start.current) / 1000));
  return (
    <WorkingIndicator
      phase={phase}
      elapsedSeconds={elapsed}
      tokensPerSecond={rate ?? undefined}
      toolName={activeTool?.name}
      argumentChars={undefined}
      dotCount={dotCount}
    />
  );
}

const LIVE_NOTICE_LIMIT = 3;

/** Repeated receipts (one line per compaction) stay in state. The live frame keeps the latest distinct lines. */
function liveNotices(notices: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const latest: string[] = [];
  for (let index = notices.length - 1; index >= 0 && latest.length < LIVE_NOTICE_LIMIT; index--) {
    const notice = notices[index]!;
    if (seen.has(notice)) continue;
    seen.add(notice);
    latest.push(notice);
  }
  latest.reverse();
  return latest;
}

/** Keep pending work visible unless its active dialog already presents it. */
/** Legacy publishes a call that waits on the user (a question or an approval) only once it is decided. */
function undecided(state: TuiState, tool: ToolView): boolean {
  return state.toolShownAt?.has(tool.id) === false;
}

export function Activity({
  state,
  dialogInteractionId,
  liveTps = null,
}: {
  readonly state: TuiState;
  readonly dialogInteractionId?: string;
  readonly liveTps?: number | null;
}): React.ReactElement {
  const theme = useTheme();
  const { TaskPanel } = useSkin();
  // Only running work belongs in the live region; settled tasks stay in the task manager, and ids stay out of the transcript.
  const liveTasks = state.tasks.filter(
    (task) => task.wire?.kind !== 'shell' && (task.status === 'running' || task.status === 'awaiting_interaction'),
  );
  return (
    <Box flexDirection="column">
      {state.activeTurnId && !state.interactions.length ? (
        <StreamingStatus key={state.activeTurnId} state={state} liveTps={liveTps} />
      ) : null}
      {(!state.activeTurnId && state.status !== 'idle') || state.cost ? (
        <Text color={theme.textSubtle}>
          {[!state.activeTurnId && state.status !== 'idle' ? state.status : '', state.cost].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {/* Legacy draws no queue-state line: a paused queue shows only its held messages. */}
      {state.commands
        .filter(
          (receipt) =>
            // Legacy has no command receipts: a rewind or retry shows only its result.
            receipt.request.operation.kind !== 'retry' &&
            receipt.request.operation.kind !== 'rewind' &&
            receipt.outcome?.kind !== 'retried' &&
            // Legacy prints nothing for a finished rewind.
            receipt.outcome?.kind !== 'rewound' &&
            (receipt.request.operation.kind !== 'configure' ||
              (receipt.outcome?.kind !== 'configured' && receipt.outcome?.kind !== 'rejected')) &&
            // Legacy shows a compaction only as its 'Compacting context...' and result lines.
            receipt.request.operation.kind !== 'compact',
        )
        .map((receipt) => (
          <Text key={receipt.request.commandId}>
            Command {receipt.request.commandId} · {receipt.request.operation.kind} ·{' '}
            {receipt.outcome?.kind ?? 'pending'}
            {receipt.outcome?.kind === 'rejected' ? `: ${receipt.outcome.message}` : ''}
            {receipt.outcome?.kind === 'interrupted' ? ' · outcome unknown' : ''}
          </Text>
        ))}
      {state.budgets.length ? <Text>Pending budget decisions: {state.budgets.length} · Ctrl+B</Text> : null}
      {state.goal ? <Text>Goal: {state.goal}</Text> : null}
      {state.verification ? <Text>Verification: {state.verification}</Text> : null}
      {state.lastError ? (
        <Text color={theme.danger}>
          {/^(?:\d{3} )?WebSocket connection closed before a terminal response event\. \(code=1006(?:\s|\))/.test(
            state.lastError,
          )
            ? 'Connection to the model dropped. /retry to try again.'
            : `Error: ${state.lastError}`}
        </Text>
      ) : null}
      {liveTasks.length ? (
        <TaskPanel header={`Tasks · ${liveTasks.length} active · /tasks manage`}>
          {liveTasks.map((task) => (
            <Text key={task.id}>
              {' '}
              {task.status === 'running' ? '◐' : '○'} {task.label} · {task.status}
              {task.detail ? ` — ${task.detail.split('\n')[0]}` : ''}
            </Text>
          ))}
        </TaskPanel>
      ) : null}
      {state.interactions.map((interaction, index) =>
        interaction.id === dialogInteractionId ? null : (
          <Box key={interaction.id} flexDirection="column">
            <Text bold>
              {index + 1}. {interaction.kind === 'approval' ? 'Approval' : 'Question'}
              {interaction.owner ? ` · ${interaction.owner}` : ''}: {interaction.title}
            </Text>
            {interaction.detail ? <Text>{interaction.detail}</Text> : null}
            {interaction.choices.map((choice, choiceIndex) => (
              <Text key={choice.id}>
                {' '}
                {choiceIndex + 1}. {choice.label}
              </Text>
            ))}
            <Text color={theme.textSubtle}>
              /answer {index + 1} &lt;choice number&gt;{interaction.acceptsText ? ' [text]' : ''}
            </Text>
          </Box>
        ),
      )}
      {state.unmatchedTools.map((tool, index) => (
        <Box key={`${tool.executionId}:${index}`} flexDirection="column">
          <Text>
            Unmatched tool result · {tool.toolName ?? 'name unavailable'} · {tool.executionId}
            {tool.isError ? ' · error' : ''}
          </Text>
          <Text>{tool.output}</Text>
          {tool.content?.map((part, partIndex) => (
            <Text key={partIndex}>{part.type === 'text' ? part.text : `[image: ${part.mediaType}]`}</Text>
          ))}
        </Box>
      ))}
      {liveNotices(state.notices).map((notice) => (
        <Text key={notice}>{notice}</Text>
      ))}
    </Box>
  );
}

/** Shown when the attached snapshot ended in an unclean interruption (not a user cancel, which settles as idle). */
export const interruptedNotice = (state: TuiState): string | null =>
  state.status === 'interrupted' || (state.activeTurnId === null && state.terminalOutcome === 'cancelled')
    ? 'Previous turn was interrupted — send a message to continue.'
    : null;

/** The one-off lines above the composer: connection trouble in the danger colour, a command's notice in legacy's system-message colour, the rest as plain text. */
export function LiveNotices({
  connectionError,
  transitionNotice,
  notice,
  historyError,
}: {
  readonly connectionError?: string | null;
  readonly transitionNotice?: string | null;
  readonly notice?: string | null;
  readonly historyError?: string | null;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <>
      {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
      {transitionNotice ? <Text>{transitionNotice}</Text> : null}
      {/* Legacy shows a command's reply as a system message, in the reasoning colour (ChatMessage.tsx). */}
      {notice ? <Text color={theme.reasoning}>{notice}</Text> : null}
      {historyError ? <Text>{historyError}</Text> : null}
    </>
  );
}

/** Render active shell work below the divider, as in the legacy task panel. */
export function ShellTaskPanel({ state }: { readonly state: TuiState }): React.ReactElement | null {
  const theme = useTheme();
  const { taskPanelGutter } = useSkin();
  const { columns: terminalColumns } = useTerminalSize();
  const columns = terminalColumns - taskPanelGutter;
  const [now, setNow] = useState(Date.now);
  const tasks = state.tasks.filter(
    (task) => task.wire?.kind === 'shell' && (task.status === 'running' || task.status === 'awaiting_interaction'),
  );
  useEffect(() => {
    if (!tasks.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tasks.length]);
  if (!tasks.length) return null;
  return (
    <Box flexDirection="column" marginBottom={2}>
      <Text color={theme.textSubtle}>Tasks · {tasks.length} active · ^G manage</Text>
      {tasks.map((task) => {
        const badge = '[Shell ↑]';
        const rawPhase = `Running · ${Math.max(0, Math.floor((now - (task.wire?.startedAt ?? now)) / 1000))}s`;
        const fixedColumns = 2 + terminalTextWidth(badge) + 1 + 3;
        const phase = truncateTerminalText(rawPhase, Math.max(1, columns - fixedColumns - 6));
        const physicalBudget = Math.max(1, columns - fixedColumns - terminalTextWidth(phase));
        const classBudget = columns < 72 ? 24 : columns >= 104 ? 60 : 36;
        const label =
          task.label
            .split('\n')
            .find((line) => line.trim())
            ?.trim()
            .replaceAll(/\s+/g, ' ') ?? '';
        return (
          <Text key={task.id} color={theme.textSubtle}>
            • {badge} {truncateTerminalText(label, Math.min(physicalBudget, classBudget))} · {phase}
          </Text>
        );
      })}
    </Box>
  );
}
