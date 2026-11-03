import React, { useEffect, useRef, useState } from 'react';
import {
  StreamingSpeedTracker,
  formatTokensPerSecond,
} from './presentation/utils/streaming/streaming-speed-tracker.js';
import { Box, Text } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import MarkdownRenderer from './presentation/components/MarkdownRenderer.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import type { Message, TuiState } from './state.js';
import { ToolCall } from './tool-view.js';
import { failedShellGroups, FailedShellSummary } from './failed-shell-summary.js';

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
  const failures = expanded ? new Map<string, number>() : failedShellGroups(state.tools);
  const usedMessages = new Set<string>();
  const usedTools = new Set<string>();
  const renderMessage = (message: Message) =>
    message.role === 'user' ? (
      <Box key={`message:${message.id}`} marginTop={1}>
        <Box flexDirection="column">
          <UserMessage text={message.text} />
          {message.attachments?.length ? (
            <Text color={theme.textSubtle}>
              [{message.attachments.length} {message.attachments.length === 1 ? 'image' : 'images'} attached]
            </Text>
          ) : null}
        </Box>
      </Box>
    ) : message.localHelp === true ? (
      <Box key={`message:${message.id}`} marginTop={1}>
        <Text color={theme.textSubtle}>{message.text}</Text>
      </Box>
    ) : message.role === 'assistant' ? (
      <Box key={`message:${message.id}`} flexDirection="column" marginTop={1} paddingLeft={2}>
        <AssistantFrame kind="answer">
          <MarkdownRenderer maxWidth={width}>{message.text}</MarkdownRenderer>
        </AssistantFrame>
        {message.interrupted ? <Text color={theme.textSubtle}>Stopped</Text> : null}
      </Box>
    ) : (
      <Box key={`message:${message.id}`} marginTop={1}>
        <Text color={message.error ? theme.danger : theme.textSubtle}>
          {message.role}: {message.text}
        </Text>
      </Box>
    );
  const ordered =
    state.timeline?.flatMap<React.ReactNode>((item) => {
      if (item.kind === 'message') {
        const message = messageById.get(item.id);
        if (!message || usedMessages.has(item.id)) return [];
        usedMessages.add(item.id);
        return [renderMessage(message)];
      }
      const tool = toolById.get(item.id);
      if (!tool || usedTools.has(item.id)) return [];
      usedTools.add(item.id);
      const count = failures.get(tool.id);
      if (count === 0) return [];
      if (count !== undefined)
        return [
          <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
            <FailedShellSummary count={count} />
          </Box>,
        ];
      return [
        <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
          <ToolCall tool={tool} expanded={expanded} />
        </Box>,
      ];
    }) ?? [];
  const remainingMessages = messages.filter((message) => !usedMessages.has(message.id));
  const remainingTools = live ? state.tools.filter((tool) => !usedTools.has(tool.id)) : [];
  return (
    <Box flexDirection="column" paddingBottom={staticRow ? 0 : 1}>
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
          <ToolCall tool={tool} expanded={expanded} />
        </Box>
      ))}
    </Box>
  );
}

/** Estimate throughput from displayed stream deltas; reset when a model step changes. */
function StreamingStatus({ state }: { readonly state: TuiState }): React.ReactElement {
  const theme = useTheme();
  const start = useRef(Date.now());
  const tracker = useRef(new StreamingSpeedTracker());
  const previous = useRef('');
  const [now, setNow] = useState(Date.now());
  const text = [...Object.values(state.reasoning), ...Object.values(state.drafts)].join('');
  const toolRunning = state.tools.some((tool) => tool.status === 'running' || tool.status === 'pending');
  useEffect(() => {
    if (toolRunning || !text.startsWith(previous.current)) {
      tracker.current.reset();
      previous.current = '';
    }
    if (!toolRunning && text.length > previous.current.length) {
      tracker.current.recordDelta(text.slice(previous.current.length));
      previous.current = text;
    }
  }, [text, toolRunning]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rate = toolRunning ? null : tracker.current.getLiveTps(now);
  const elapsed = Math.max(0, Math.floor((now - start.current) / 1000));
  return (
    <Text color={theme.textSubtle}>
      {toolRunning ? 'Running tools' : 'Generating'} · {elapsed}s
      {rate && rate > 0 ? ` (${formatTokensPerSecond(rate, true)})` : ''}
    </Text>
  );
}

/** Fold completed compaction receipts without losing the latest definite failure. */
export function compactFailureMessage(state: TuiState): string | null {
  const latest = state.commands
    .filter(
      (receipt) =>
        receipt.request.operation.kind === 'compact' &&
        (receipt.outcome?.kind === 'compacted' || receipt.outcome?.kind === 'rejected'),
    )
    .at(-1)?.outcome;
  return latest?.kind === 'rejected' && latest.message !== 'Compaction did not replace history: no_complete_cold_turn.'
    ? `Compaction failed: ${latest.message}`
    : null;
}

/** Keep pending work visible unless its active dialog already presents it. */
export function Activity({
  state,
  dialogInteractionId,
  notice,
}: {
  readonly state: TuiState;
  readonly dialogInteractionId?: string;
  readonly notice?: string | null;
}): React.ReactElement {
  const theme = useTheme();
  const { TaskPanel } = useSkin();
  const compactFailure = compactFailureMessage(state);
  // Only running work belongs in the live region; settled tasks stay in the task manager, and ids stay out of the transcript.
  const liveTasks = state.tasks.filter((task) => task.status === 'running' || task.status === 'awaiting_interaction');
  return (
    <Box flexDirection="column">
      {state.activeTurnId ? <StreamingStatus key={state.activeTurnId} state={state} /> : null}
      {(!state.activeTurnId && state.status !== 'idle') || state.cost ? (
        <Text color={theme.textSubtle}>
          {[!state.activeTurnId && state.status !== 'idle' ? state.status : '', state.cost].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {state.queueState !== 'idle' && (state.queueState !== 'running' || state.queue.length > 0) ? (
        <Text>
          Queue: {state.queueState}
          {state.queuePauseReason ? ` · ${state.queuePauseReason}` : ''}
        </Text>
      ) : null}
      {state.commands
        .filter(
          (receipt) =>
            receipt.outcome?.kind !== 'retried' &&
            (receipt.request.operation.kind !== 'configure' ||
              (receipt.outcome?.kind !== 'configured' && receipt.outcome?.kind !== 'rejected')) &&
            (receipt.request.operation.kind !== 'compact' ||
              (receipt.outcome?.kind !== 'compacted' && receipt.outcome?.kind !== 'rejected')),
        )
        .map((receipt) => (
          <Text key={receipt.request.commandId}>
            Command {receipt.request.commandId} · {receipt.request.operation.kind} ·{' '}
            {receipt.outcome?.kind ?? 'pending'}
            {receipt.outcome?.kind === 'rejected' ? `: ${receipt.outcome.message}` : ''}
            {receipt.outcome?.kind === 'interrupted' ? ' · outcome unknown' : ''}
          </Text>
        ))}
      {compactFailure && compactFailure !== notice ? <Text color={theme.danger}>{compactFailure}</Text> : null}
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
      {state.queue.map((item, index) => (
        <Text key={item.id}>
          Queued {index + 1} ({item.delivery}): {item.displayText ?? item.text}
        </Text>
      ))}
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
      {state.notices.map((notice, index) => (
        <Text key={index}>{notice}</Text>
      ))}
    </Box>
  );
}

/** Shown when the attached snapshot ended in an unclean interruption (not a user cancel, which settles as idle). */
export const interruptedNotice = (state: TuiState): string | null =>
  state.status === 'interrupted' || (state.activeTurnId === null && state.terminalOutcome === 'cancelled')
    ? 'Previous turn was interrupted — send a message to continue.'
    : null;

/** The one-off lines above the composer: connection trouble in the danger colour, the rest as plain text. */
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
      {[transitionNotice, notice, historyError].map((text, index) => (text ? <Text key={index}>{text}</Text> : null))}
    </>
  );
}

/** Explicit shell output keeps the compact themed status visible; Ctrl+O reveals details. */
export function BangResult({
  result,
  expanded,
}: {
  readonly result: string;
  readonly expanded: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const [header = '', ...detail] = result.split('\n');
  return (
    <Box flexDirection="column">
      <Text color={header.startsWith('✓') ? theme.success : theme.danger}>{header}</Text>
      {expanded && detail.length ? <Text>{detail.join('\n')}</Text> : null}
    </Box>
  );
}
