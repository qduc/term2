import React, { useContext } from 'react';
import { LiveToolAgeContext, LiveToolAgesContext } from './live-tool-age.js';
import CommandMessage from './presentation/components/message/CommandMessage.js';
import type { ToolView } from './state.js';
import type { JsonValue } from '../../protocol/direct-wire.js';

/**
 * One tool row, drawn by legacy's own CommandMessage so labels, bold, colours and layout match by
 * construction. The wire's `display` carries the legacy command messages the source tool published;
 * a call without one (an unknown tool) is drawn from its name and arguments, as legacy did.
 */
export function ToolCall({
  tool,
  expanded = false,
  awaitingDecision = false,
}: {
  readonly tool: ToolView;
  readonly expanded?: boolean;
  /** Legacy's `turnPaused`: a live row reads "(waiting)" while a question or approval is up. */
  readonly awaitingDecision?: boolean;
  /** Accepted for callers that pass it; legacy's CommandMessage draws a running shell without an elapsed label. */
  readonly startedAt?: number;
}): React.ReactElement | null {
  const age = useContext(LiveToolAgesContext)?.get(tool.id);
  const message = commandMessages(tool.display)[0];
  // A call the user denied never ran, so no command message was published; legacy draws it as a rejected row.
  const denied = !message && tool.status === 'failed' && tool.detail?.startsWith(DENIED_PREFIX) === true;
  // An unknown tool never ran, so it published no command message either. Legacy draws it as a finished ✓ row,
  // a confirmed legacy bug (#136 item 14, accepted-differences): next draws it failed, with the result text.
  const unknown = !message && !denied && isUnknownToolCall(tool);
  // Any other call without a command message is drawn from its arguments alone, as a finished row, as in legacy.
  const status = tool.outcomeUnknown
    ? 'unknown'
    : tool.status === 'rejected'
    ? 'failed'
    : tool.status === 'failed' && !message && !denied && !unknown
    ? 'completed'
    : tool.status;
  const output =
    typeof message?.output === 'string' ? message.output : message || denied || unknown ? tool.detail ?? '' : '';
  const success =
    typeof message?.success === 'boolean'
      ? message.success
      : (message || denied || unknown) && (tool.status === 'failed' || tool.status === 'rejected')
      ? false
      : undefined;
  const row = (
    <CommandMessage
      command={typeof message?.command === 'string' ? message.command : inFlightLabel(tool)}
      output={output}
      status={status}
      success={success}
      {...(typeof message?.failureReason === 'string' ? { failureReason: message.failureReason } : {})}
      toolName={tool.name}
      toolArgs={tool.input}
      isApprovalRejection={tool.status === 'rejected' || denied || message?.isApprovalRejection === true}
      autoApprovedByLlm={message?.autoApprovedByLlm === true}
      hadApproval={message?.hadApproval === true}
      displayMode={expanded ? 'standard' : 'concise'}
      isSubagent={Boolean(tool.parent)}
      awaitingDecision={awaitingDecision}
    />
  );
  return age ? <LiveToolAgeContext.Provider value={age}>{row}</LiveToolAgeContext.Provider> : row;
}

/** The engine's result for a call to a tool the turn did not offer (`engine/turn-tools.ts`). */
export function isUnknownToolCall(tool: ToolView): boolean {
  return tool.status === 'failed' && tool.detail?.startsWith(`Unknown tool: ${tool.name}`) === true;
}

/** The result text legacy's runner records for a denied call. */
const DENIED_PREFIX = 'Tool execution was not approved';

/** The legacy command messages a source tool published as the call's `display`. */
function commandMessages(display: JsonValue | undefined): Record<string, JsonValue>[] {
  const messages = Array.isArray(display)
    ? display
    : isRecord(display) && Array.isArray(display.messages)
    ? display.messages
    : [];
  return messages.filter(
    (message): message is Record<string, JsonValue> => isRecord(message) && message.sender === 'command',
  );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Until a shell call publishes its command message, legacy labels the row from the call's arguments. */
function inFlightLabel(tool: ToolView): string {
  if (tool.name !== 'shell') return '';
  const input = tool.input;
  const label = isRecord(input as JsonValue)
    ? (input as Record<string, JsonValue>).description ?? (input as Record<string, JsonValue>).command
    : undefined;
  return typeof label === 'string' ? label : '';
}
