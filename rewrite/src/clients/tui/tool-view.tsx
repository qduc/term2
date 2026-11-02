import React from 'react';
import { Box, Text } from 'ink';
import { formatToolArgs } from '../../../../source/components/message/command-message-helpers.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import { useTheme } from '../../../../source/components/theme.js';
import type { ToolView } from './state.js';

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
  const display = tool.display === undefined || tool.display === null ? '' : JSON.stringify(tool.display, null, 2);
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
