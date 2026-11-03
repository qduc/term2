import React from 'react';
import { Box, Text } from 'ink';
import { formatToolArgs } from './presentation/components/message/command-message-helpers.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { useTheme } from './presentation/components/theme.js';
import type { ToolView } from './state.js';
import type { JsonValue } from '../../protocol/direct-wire.js';

/** The tools whose edit is the point of the row: the old terminal printed these as diffs, so they stay open. */
const EDIT_TOOLS = new Set(['search_replace', 'create_file']);

/** `Runtime: 63ms` is how shell results report their duration; no other tool reports one on the wire. The last match wins. */
function runtimeOf(...texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const matches = [...text.matchAll(/^Runtime:\s*(\d+(?:\.\d+)?\s*(?:ms|s|m|h))\s*$/gm)];
    const last = matches[matches.length - 1];
    if (last) return last[1]!.replace(/\s+/g, '');
  }
  return undefined;
}

/** Legacy marks an unregistered create_file call completed in the UI, despite its error result. */
export function isUnknownCreateFile(tool: ToolView): boolean {
  return tool.name === 'create_file' && tool.status === 'failed' && tool.detail === 'Unknown tool: create_file';
}

/**
 * One row per tool call, like the old terminal: `✓ <what it did> (63ms)`. Output, scripts and nested-run
 * details stay behind expand (Ctrl+O) for settled calls; unknown outcomes, live calls and questions stay open.
 */
export function ToolCall({
  tool,
  expanded = false,
  startedAt,
}: {
  readonly tool: ToolView;
  readonly expanded?: boolean;
  readonly startedAt?: number;
}): React.ReactElement {
  const { ToolFrame, ToolHeader, ToolSection } = useSkin();
  const theme = useTheme();
  // Question text belongs to its interactive page, not an all-pages tool summary.
  const args =
    tool.name === 'ask_user'
      ? ''
      : tool.name === 'shell'
      ? shellTitle(tool.input)
      : formatToolArgs(tool.name, tool.input, 'concise');
  const detail = tool.detail ?? '';
  const contentText = (tool.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const extraText = contentText && contentText !== detail ? contentText : '';
  const images = (tool.content ?? []).flatMap((part) => (part.type === 'image' ? [part.mediaType] : []));
  // A source tool can report a failure (non-zero exit, timeout) with isError false; its command message says so.
  const unknownCreateFile = isUnknownCreateFile(tool);
  const status = unknownCreateFile
    ? 'completed'
    : tool.status === 'completed' && reportsFailure(tool.display)
    ? 'failed'
    : tool.status;
  const open =
    expanded ||
    status === 'pending' ||
    status === 'running' ||
    Boolean(tool.outcomeUnknown) ||
    tool.name === 'ask_user';
  // Text that is hidden cannot stand in for the lines that are shown.
  const fresh = (part: string) => !open || (!detail.includes(part) && !extraText.includes(part));
  const inputText =
    tool.name === 'shell'
      ? expanded
        ? inputParts(tool.name, tool.input)
        : []
      : inputParts(tool.name, tool.input).filter(fresh);
  const displayText = displayParts(tool.display, args, tool.name).filter(fresh);
  const runtime =
    tool.name === 'shell'
      ? runtimeOf(detail) ??
        (startedAt != null && status === 'running'
          ? `${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`
          : undefined)
      : undefined;
  // Successful edits keep their diff visible; failed calls remain one summary row.
  const showEdit = !unknownCreateFile && EDIT_TOOLS.has(tool.name) && status !== 'failed' && status !== 'rejected';
  const display = [...(open || showEdit ? inputText : []), ...(open ? displayText : [])].join('\n');
  const showDetail = open;
  const reason = !open && tool.name === 'shell' && status === 'failed' ? shellFailureReason(detail) : '';
  return (
    <ToolFrame status={status} display="standard" toolName={tool.name}>
      <Box flexDirection="column" width="100%">
        <Box height={!open && (status === 'failed' || status === 'rejected') ? 1 : undefined} overflow="hidden">
          <ToolHeader
            status={status}
            display="standard"
            toolName={tool.name}
            nested={Boolean(tool.parent)}
            action={
              <Text>
                {reason ? `${reason} · ` : ''}
                {unknownCreateFile ? `Created ${args}` : args || tool.name}
              </Text>
            }
            meta={
              tool.outcomeUnknown ? (
                <Text color={theme.warning}>outcome unknown</Text>
              ) : unknownCreateFile ? (
                <Text>
                  {' '}
                  (
                  <Text color={theme.textMuted}>
                    +
                    {isRecord(tool.input) && typeof tool.input.content === 'string'
                      ? tool.input.content.split('\n').length
                      : 1}
                  </Text>{' '}
                  <Text color={theme.danger}>-0</Text>)
                </Text>
              ) : runtime ? (
                <Text color={theme.textSubtle}> ({runtime})</Text>
              ) : undefined
            }
          />
        </Box>
        {open && tool.parent ? <Text color={theme.textSubtle}>Parent execution: {tool.parent}</Text> : null}
        {(showDetail && (detail || extraText || images.length)) || display ? (
          <ToolSection variant="indent">
            <Box flexDirection="column">
              {showDetail && detail ? <Text>{detail}</Text> : null}
              {showDetail && extraText ? <Text>{extraText}</Text> : null}
              {(showDetail ? images : []).map((mediaType, index) => (
                <Text key={index} color={theme.textSubtle}>
                  [image: {mediaType}]
                </Text>
              ))}
              {display ? <Text color={theme.textSubtle}>{display}</Text> : null}
            </Box>
          </ToolSection>
        ) : null}
      </Box>
    </ToolFrame>
  );
}

/** Show the shell status and an explicitly labelled fatal/error line, not arbitrary hidden output. */
function shellFailureReason(detail: string): string {
  const status = /^(exit \d+|timeout|cancelled)\s*$/m.exec(detail)?.[1];
  if (!status) return '';
  const diagnostic = /^(?:fatal|error):[^\r\n]*/im
    .exec(detail)?.[0]
    ?.replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  const short = diagnostic && diagnostic.length > 44 ? `${diagnostic.slice(0, 43)}…` : diagnostic;
  return short ? `${status}: ${short}` : status;
}

/** Prefer the model's intent, never the raw command, in the collapsed shell row. */
function shellTitle(input: JsonValue | undefined): string {
  const description = isRecord(input) && typeof input.description === 'string' ? input.description : '';
  const singleLine = description.replace(/\s+/g, ' ').trim();
  return singleLine ? (singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine) : 'Shell command';
}

/**
 * Source tools publish legacy command messages as `display`: an array, or `{messages, approvalPresentation}`.
 * Include command and output when not already represented by the header or input. Unknown shapes stay visible as JSON.
 */
function displayParts(display: JsonValue | undefined, header: string, toolName: string): string[] {
  if (display === undefined || display === null) return [];
  const messages = Array.isArray(display)
    ? display
    : isRecord(display) && Array.isArray(display.messages)
    ? display.messages
    : undefined;
  if (messages?.every((message) => isRecord(message) && message.sender === 'command')) {
    // The concise header truncates long shell commands; keep the full command when it says more. Tools whose
    // input is rendered by `inputParts` already show their edit/script there, so their command line would repeat it.
    const commandShown = !INPUT_RENDERED.has(toolName);
    return messages.flatMap((message) =>
      [isRecord(message) ? message.command : '', isRecord(message) ? message.output : ''].flatMap((part, index) =>
        typeof part === 'string' && part && !(index === 0 && (!commandShown || header.includes(part))) ? [part] : [],
      ),
    );
  }
  return [JSON.stringify(display, null, 2)];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_INPUT_LINES = 40;
const INPUT_RENDERED = new Set(['shell', 'search_replace', 'create_file', 'run_code']);

/**
 * What the model asked a tool to do, where the concise header only summarises it: edit text, new file content,
 * a script, or a long subagent task. The legacy renderer showed these as diffs; the old JSON dump showed them raw.
 */
function inputParts(name: string, input: JsonValue | undefined): string[] {
  if (!isRecord(input)) return [];
  const mark = (prefix: string, text: unknown) =>
    typeof text === 'string' && text
      ? text
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => `${prefix}${line}`)
      : [];
  let lines: string[] = [];
  if (name === 'shell') {
    const command = input.command ?? input.commands;
    lines =
      typeof command === 'string'
        ? mark('', command)
        : Array.isArray(command)
        ? command.flatMap((part) => mark('', part))
        : [];
  } else if (name === 'search_replace') {
    const edits = Array.isArray(input.replacements) ? input.replacements : [input];
    lines = edits.flatMap((edit) =>
      isRecord(edit) ? [...mark('- ', edit.search_content), ...mark('+ ', edit.replace_content)] : [],
    );
  } else if (name === 'create_file') lines = mark('+ ', input.content);
  else if (name === 'run_code') lines = mark('', input.code);
  else if (name === 'run_subagent' || name === 'run_subagent_async') {
    lines = typeof input.task === 'string' && input.task.length > 40 ? mark('', input.task) : [];
  }
  if (name !== 'shell' && lines.length > MAX_INPUT_LINES) {
    lines = [...lines.slice(0, MAX_INPUT_LINES), `… ${lines.length - MAX_INPUT_LINES} more lines`];
  }
  return lines.length ? [lines.join('\n')] : [];
}

/** True when a legacy command message in `display` marks the call unsuccessful. */
export function reportsFailure(display: JsonValue | undefined): boolean {
  const messages = Array.isArray(display)
    ? display
    : isRecord(display) && Array.isArray(display.messages)
    ? display.messages
    : [];
  return messages.some((message) => isRecord(message) && message.success === false);
}
