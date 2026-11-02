import React from 'react';
import { Box, Text } from 'ink';
import { formatToolArgs } from '../../../../source/components/message/command-message-helpers.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import { useTheme } from '../../../../source/components/theme.js';
import type { ToolView } from './state.js';
import type { JsonValue } from '../../protocol/direct-wire.js';

/** Render only the public tool occurrence and result supplied by the direct wire. */
export function ToolCall({ tool }: { readonly tool: ToolView }): React.ReactElement {
  const { ToolFrame, ToolHeader, ToolSection } = useSkin();
  const theme = useTheme();
  // Question text belongs to its interactive page, not an all-pages tool summary.
  const args = tool.name === 'ask_user' ? '' : formatToolArgs(tool.name, tool.input, 'concise');
  const detail = tool.detail ?? '';
  const contentText = (tool.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const extraText = contentText && contentText !== detail ? contentText : '';
  const images = (tool.content ?? []).flatMap((part) => (part.type === 'image' ? [part.mediaType] : []));
  const display = [...inputParts(tool.name, tool.input), ...displayParts(tool.display, args)]
    .filter((part) => !detail.includes(part) && !extraText.includes(part))
    .join('\n');
  return (
    <ToolFrame status={tool.status} display="standard" toolName={tool.name}>
      <ToolHeader
        status={tool.status}
        display="standard"
        toolName={tool.name}
        nested={Boolean(tool.parent)}
        action={<Text>{args || tool.name}</Text>}
        meta={tool.outcomeUnknown ? <Text color={theme.warning}>outcome unknown</Text> : undefined}
      />
      {tool.parent ? <Text color={theme.textSubtle}>Parent execution: {tool.parent}</Text> : null}
      {detail || extraText || display || images.length ? (
        <ToolSection variant="indent">
          <Box flexDirection="column">
            {detail ? <Text>{detail}</Text> : null}
            {extraText ? <Text>{extraText}</Text> : null}
            {images.map((mediaType, index) => (
              <Text key={index} color={theme.textSubtle}>
                [image: {mediaType}]
              </Text>
            ))}
            {display ? <Text color={theme.textSubtle}>{display}</Text> : null}
          </Box>
        </ToolSection>
      ) : null}
    </ToolFrame>
  );
}

/**
 * Source tools publish legacy command messages as `display`: an array, or `{messages, approvalPresentation}`.
 * The header already shows the command, so only each message's output is shown. Unknown shapes stay visible as JSON.
 */
function displayParts(display: JsonValue | undefined, header: string): string[] {
  if (display === undefined || display === null) return [];
  const messages = Array.isArray(display)
    ? display
    : isRecord(display) && Array.isArray(display.messages)
    ? display.messages
    : undefined;
  if (messages?.every((message) => isRecord(message) && message.sender === 'command')) {
    // The concise header truncates long commands and edits; keep the full command when it says more.
    return messages.flatMap((message) =>
      [isRecord(message) ? message.command : '', isRecord(message) ? message.output : ''].flatMap((part, index) =>
        typeof part === 'string' && part && !(index === 0 && header.includes(part)) ? [part] : [],
      ),
    );
  }
  return [JSON.stringify(display, null, 2)];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_INPUT_LINES = 40;

/**
 * What the model asked a tool to do, where the concise header only summarises it: edit text, new file content,
 * a script, or a long subagent task. The legacy renderer showed these as diffs; the old JSON dump showed them raw.
 */
function inputParts(name: string, input: JsonValue | undefined): string[] {
  if (!isRecord(input)) return [];
  const mark = (prefix: string, text: unknown) =>
    typeof text === 'string' && text ? text.split('\n').map((line) => `${prefix}${line}`) : [];
  let lines: string[] = [];
  if (name === 'search_replace') {
    const edits = Array.isArray(input.replacements) ? input.replacements : [input];
    lines = edits.flatMap((edit) =>
      isRecord(edit) ? [...mark('- ', edit.search_content), ...mark('+ ', edit.replace_content)] : [],
    );
  } else if (name === 'create_file') lines = mark('+ ', input.content);
  else if (name === 'run_code') lines = mark('', input.code);
  else if (name === 'run_subagent' || name === 'run_subagent_async') {
    lines = typeof input.task === 'string' && input.task.length > 40 ? mark('', input.task) : [];
  }
  if (lines.length > MAX_INPUT_LINES) {
    lines = [...lines.slice(0, MAX_INPUT_LINES), `… ${lines.length - MAX_INPUT_LINES} more lines`];
  }
  return lines.length ? [lines.join('\n')] : [];
}
