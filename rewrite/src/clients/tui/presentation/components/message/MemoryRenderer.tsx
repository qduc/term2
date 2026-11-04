import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseMemoryOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  output: string;
  toolName: string;
  query?: string;
  renderStandardHeader: () => React.ReactElement;
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

const MemoryRenderer: FC<Props> = ({ output, toolName, query, renderStandardHeader }) => {
  const theme = useTheme();
  const { ToolSection } = useSkin();
  const parsed = parseMemoryOutput(output) as any;
  if (!parsed) return null;

  if (parsed.type === 'error') {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <ToolSection variant="indent">
          <Text color={theme.danger}>
            {parsed.code ? `[${parsed.code}] ` : ''}
            {parsed.message}
          </Text>
        </ToolSection>
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
        <ToolSection variant="indent">
          <Text color={theme.textSubtle} dimColor>
            {total} memor{total === 1 ? 'y' : 'ies'} found
            {parsed.omitted ? `; ${parsed.omitted} omitted` : ''}
            {parsed.unavailable ? `; ${parsed.unavailable} unavailable` : ''}
          </Text>
          {groups.map(([label, memories]) => (
            <Box key={label} flexDirection="column">
              <Text color={theme.accent} bold>
                {label}
              </Text>
              {memories.length === 0 ? (
                <Text color={theme.textSubtle} dimColor>
                  none
                </Text>
              ) : (
                memories.map((m: any, idx: number) => (
                  <Box key={idx} flexDirection="column" marginTop={1}>
                    <Text color={theme.accent} bold>
                      {m.title || m.id}
                    </Text>
                    {m.summary ? (
                      <Text color={theme.textSubtle} dimColor>
                        {truncate(m.summary, 140)}
                      </Text>
                    ) : null}
                    {m.tags && m.tags.length > 0 ? (
                      <Text color={theme.textSubtle} dimColor>
                        tags: {m.tags.join(', ')}
                      </Text>
                    ) : null}
                    {m.scope ? (
                      <Text color={theme.textSubtle} dimColor>
                        scope: {m.scope}
                      </Text>
                    ) : null}
                  </Box>
                ))
              )}
            </Box>
          ))}
        </ToolSection>
      </Box>
    );
  }

  if (parsed.type === 'get') {
    const m = parsed.memory;
    if (toolName === 'memory_create') {
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          <Box flexDirection="column" marginTop={1}>
            <ToolSection variant="indent">
              <Text color={theme.toolOutput} dimColor>
                Saved memory {m?.id ? `"${m.id}"` : ''}
                {m?.title ? ` - "${m.title}"` : ''}
              </Text>
            </ToolSection>
          </Box>
        </Box>
      );
    }
    if (toolName === 'memory_update') {
      return (
        <Box flexDirection="column">
          {renderStandardHeader()}
          <Box flexDirection="column" marginTop={1}>
            <ToolSection variant="indent">
              <Text color={theme.toolOutput} dimColor>
                Updated memory {m?.id ? `"${m.id}"` : ''}
                {m?.title ? ` - "${m.title}"` : ''}
              </Text>
            </ToolSection>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Box flexDirection="column" marginTop={1}>
          <ToolSection variant="panel">
            <Text color={theme.text} bold>
              {m.title || m.id}
            </Text>
            {m.summary ? (
              <Text color={theme.textSubtle} dimColor>
                {m.summary}
              </Text>
            ) : null}
            {m.tags && m.tags.length > 0 ? (
              <Text color={theme.textSubtle} dimColor>
                tags: {m.tags.join(', ')}
              </Text>
            ) : null}
            {m.content ? (
              <Box marginTop={1}>
                <Text color={theme.toolOutput}>{m.content}</Text>
              </Box>
            ) : null}
          </ToolSection>
        </Box>
      </Box>
    );
  }

  if (parsed.type === 'search') {
    const { results } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        <ToolSection variant="indent">
          <Text color={theme.textSubtle} dimColor>
            {results.length} result{results.length === 1 ? '' : 's'}
            {query ? ` for "${query}"` : ''}
            {parsed.omitted ? `; ${parsed.omitted} omitted` : ''}
          </Text>
        </ToolSection>
        <ToolSection variant="indent">
          {results.map((r: any, idx: number) => (
            <Box key={idx} flexDirection="column" marginTop={1}>
              <Text color={theme.accent} bold>
                {r.memory?.title || r.memory?.id}
              </Text>
              <Text color={theme.textSubtle} dimColor>
                [{r.scope || 'all'}] matched: {(r.matchedFields || []).join(', ') || 'n/a'}
              </Text>
              {r.memory?.summary ? <Text color={theme.toolOutput}>{truncate(r.memory.summary, 140)}</Text> : null}
              {r.contentSnippet?.text ? <Text color={theme.toolOutput}>{r.contentSnippet.text}</Text> : null}
            </Box>
          ))}
        </ToolSection>
      </Box>
    );
  }

  if (parsed.type === 'delete') {
    return (
      <Box flexDirection="column">
        {renderStandardHeader()}
        <Box flexDirection="column" marginTop={1}>
          <ToolSection variant="indent">
            <Text color={theme.toolOutput} dimColor>
              {parsed.deleted ? 'Deleted' : 'Memory not found'}
            </Text>
          </ToolSection>
        </Box>
      </Box>
    );
  }

  return null;
};

export default MemoryRenderer;
