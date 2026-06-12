import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { COLOR_TOOL_OUTPUT } from '../theme.js';

interface DiffViewProps {
  diff: string;
}

const collapseUnchangedLines = (lines: string[]): string[] => {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isUnchanged = (l: string | undefined) =>
      l !== undefined && !l.startsWith('+') && !l.startsWith('-') && !l.startsWith('@@');

    if (!isUnchanged(line)) {
      result.push(line);
      i++;
      continue;
    }

    // Find the end of the consecutive unchanged lines block
    let j = i;
    while (j < lines.length && isUnchanged(lines[j])) {
      j++;
    }

    const unchangedCount = j - i;
    const maxUnchangedContext = 3;

    if (unchangedCount <= maxUnchangedContext * 2 + 1) {
      for (let k = i; k < j; k++) {
        result.push(lines[k]);
      }
    } else {
      // Keep first 3 lines
      for (let k = i; k < i + maxUnchangedContext; k++) {
        result.push(lines[k]);
      }
      // Add placeholder line
      const skippedCount = unchangedCount - maxUnchangedContext * 2;
      result.push(` ... (${skippedCount} unchanged lines) ...`);
      // Keep last 3 lines
      for (let k = j - maxUnchangedContext; k < j; k++) {
        result.push(lines[k]);
      }
    }

    i = j;
  }
  return result;
};

export const DiffView: FC<DiffViewProps> = ({ diff }) => {
  try {
    const trimmedDiff = diff.trimEnd();
    const rawLines = trimmedDiff.split('\n');
    const collapsedLines = collapseUnchangedLines(rawLines);

    const maxLines = 30;
    const truncated = collapsedLines.length > maxLines + 1;
    const displayLines = truncated ? collapsedLines.slice(0, maxLines) : collapsedLines;
    const lastLine = truncated ? collapsedLines[collapsedLines.length - 1] : null;

    const renderLine = (line: string, key: any) => {
      let color: string | undefined;
      if (line.startsWith('+')) {
        color = 'green';
      } else if (line.startsWith('-')) {
        color = 'red';
      } else if (line.startsWith('@@')) {
        color = 'cyan';
      }

      return (
        <Text key={key} color={color || COLOR_TOOL_OUTPUT}>
          {line}
        </Text>
      );
    };

    return (
      <Box flexDirection="column" marginLeft={2}>
        {displayLines.map((line, i) => renderLine(line, i))}
        {truncated && <Text color={COLOR_TOOL_OUTPUT}>... ({collapsedLines.length - maxLines - 1} more lines)</Text>}
        {truncated && lastLine !== null && renderLine(lastLine, 'last')}
      </Box>
    );
  } catch (error) {
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color="red">[Failed to render diff preview]</Text>
      </Box>
    );
  }
};

export default DiffView;
