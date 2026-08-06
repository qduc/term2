import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseMemoryOutput } from './command-message-helpers.js';
import { COLOR_MUTED, COLOR_TOOL_OUTPUT } from '../theme.js';

const COLOR_ERROR = 'red';
const COLOR_INFO = 'cyan';
const COLOR_CONTENT = 'white';

type Props = {
  output: string;
  toolName: string;
  renderStandardHeader: () => React.ReactElement;
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

const MemoryRenderer: FC<Props> = ({ output, toolName, renderStandardHeader }) => {
  const parsed = parseMemoryOutput(output) as any;
  if (!parsed) return null;

  if (parsed.type === 'error') {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Box paddingLeft={2}>
          <Text color={COLOR_ERROR}>
            {parsed.code ? `[${parsed.code}] ` : ''}
            {parsed.message}
          </Text>
        </Box>
      </Box>
    );
  }

  if (parsed.type === 'list') {
    const sections = parsed.scope === 'all' ? { Global: parsed.global || [], Project: parsed.project || [] } : null;
    const groups = sections ? Object.entries(sections) : ([['All', parsed.memories || []]] as [string, any[]][]);
    const total = groups.reduce((sum, [, list]) => sum + list.length, 0);
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={COLOR_MUTED} dimColor>
            {total} memor{total === 1 ? 'y' : 'ies'} found
          </Text>
          {groups.map(([label, memories]) => (
            <Box key={label} flexDirection="column">
              <Text color={COLOR_INFO} bold>
                {label}
              </Text>
              {memories.length === 0 ? (
                <Text color={COLOR_MUTED} dimColor>
                  none
                </Text>
              ) : (
                memories.map((m: any, idx: number) => (
                  <Box key={idx} flexDirection="column" marginTop={1}>
                    <Text color={COLOR_INFO} bold>
                      {m.title || m.id}
                    </Text>
                    {m.summary ? (
                      <Text color={COLOR_MUTED} dimColor>
                        {truncate(m.summary, 140)}
                      </Text>
                    ) : null}
                    {m.tags && m.tags.length > 0 ? (
                      <Text color={COLOR_MUTED} dimColor>
                        tags: {m.tags.join(', ')}
                      </Text>
                    ) : null}
                  </Box>
                ))
              )}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  if (parsed.type === 'get') {
    const m = parsed.memory;
    if (toolName === 'memory_create') {
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          <Box paddingLeft={2} marginTop={1}>
            <Text color={COLOR_TOOL_OUTPUT} dimColor>
              Saved memory {m?.id ? `"${m.id}"` : ''}
              {m?.title ? ` - "${m.title}"` : ''}
            </Text>
          </Box>
        </Box>
      );
    }
    if (toolName === 'memory_update') {
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          <Box paddingLeft={2} marginTop={1}>
            <Text color={COLOR_TOOL_OUTPUT} dimColor>
              Updated memory {m?.id ? `"${m.id}"` : ''}
              {m?.title ? ` - "${m.title}"` : ''}
            </Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Box flexDirection="column" borderStyle="single" borderColor={COLOR_MUTED} paddingX={1} marginTop={1}>
          <Text color={COLOR_CONTENT} bold>
            {m.title || m.id}
          </Text>
          {m.summary ? (
            <Text color={COLOR_MUTED} dimColor>
              {m.summary}
            </Text>
          ) : null}
          {m.tags && m.tags.length > 0 ? (
            <Text color={COLOR_MUTED} dimColor>
              tags: {m.tags.join(', ')}
            </Text>
          ) : null}
          {m.content ? (
            <Box marginTop={1}>
              <Text color={COLOR_TOOL_OUTPUT}>{m.content}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    );
  }

  if (parsed.type === 'search') {
    const { query, results } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        <Box paddingLeft={2}>
          <Text color={COLOR_MUTED} dimColor>
            {results.length} result{results.length === 1 ? '' : 's'} for "{query}"
          </Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {results.map((r: any, idx: number) => (
            <Box key={idx} flexDirection="column" marginTop={1}>
              <Text color={COLOR_INFO} bold>
                {r.memory?.title || r.memory?.id}
              </Text>
              <Text color={COLOR_MUTED} dimColor>
                matched: {(r.matchedFields || []).join(', ') || 'n/a'}
              </Text>
              {r.memory?.summary ? <Text color={COLOR_TOOL_OUTPUT}>{truncate(r.memory.summary, 140)}</Text> : null}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  if (parsed.type === 'delete') {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Box paddingLeft={2} marginTop={1}>
          <Text color={COLOR_TOOL_OUTPUT} dimColor>
            {parsed.deleted ? 'Deleted' : 'Memory not found'}
          </Text>
        </Box>
      </Box>
    );
  }

  return null;
};

export default MemoryRenderer;
