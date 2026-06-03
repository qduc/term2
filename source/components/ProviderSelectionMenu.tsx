import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type {
  ProviderSelectionPhase,
  CustomProviderDraft,
  ProviderSelectionMenuItem,
} from '../hooks/use-provider-selection.js';
import { MenuContainer } from './Common/MenuContainer.js';

type Props = {
  phase: ProviderSelectionPhase;
  selectedIndex: number;
  scrollOffset?: number;
  activeItems: ProviderSelectionMenuItem[];
  errorMessage: string | null;
  fieldErrors?: Record<string, string>;
  selectedProviderName?: string;
  draft: CustomProviderDraft | null;
};

const ProviderSelectionMenu: FC<Props> = ({
  phase,
  selectedIndex,
  scrollOffset,
  activeItems,
  errorMessage,
  fieldErrors,
  selectedProviderName,
  draft,
}) => {
  const getHeader = () => {
    switch (phase) {
      case 'list':
        return 'Provider Management';
      case 'wizard_type':
        return 'Step 2: Provider Type';
      case 'edit_fields':
        return 'Review & Save Provider';
      case 'confirm_delete':
        return `Delete Provider: ${selectedProviderName}`;
      case 'confirm_discard':
        return 'Discard Changes?';
      case 'wizard_name':
        return 'Step 1: Provider Name';
      case 'wizard_url':
        return 'Step 3: Base URL';
      case 'wizard_key':
        return 'Step 4: API Key';
      default:
        return 'Manage Providers';
    }
  };

  const getFooter = () => {
    switch (phase) {
      case 'list':
        return 'Enter → Edit custom provider · Del → Delete custom provider · Esc → Close Menu · ↑↓ → Navigate';
      case 'confirm_delete':
      case 'confirm_discard':
      case 'wizard_type':
        return 'Enter → Select · Esc → Go Back · ↑↓ → Navigate';
      case 'edit_fields':
        return 'Enter → Modify field / Save · Esc → Cancel · ↑↓ → Navigate';
      case 'wizard_name':
      case 'wizard_url':
      case 'wizard_key':
        return 'Type value below and press Enter · Esc → Go Back';
      default:
        return '';
    }
  };

  const getBorderColor = () => {
    if (errorMessage) return 'red';
    if (phase === 'confirm_delete' || phase === 'confirm_discard') return 'red';
    return 'cyan';
  };

  // Render a help card for text prompt wizard steps
  const renderTextWizardPrompt = () => {
    let description = '';
    let currentValue = '';

    if (phase === 'wizard_name') {
      description = 'Enter a unique name for this provider. Example: local-llama';
      currentValue = draft?.name || '';
    } else if (phase === 'wizard_url') {
      description = 'Enter the Base API URL (e.g. http://localhost:11434/v1).';
      currentValue = draft?.baseUrl || '';
    } else if (phase === 'wizard_key') {
      description = 'Enter the API key for credentials. Leave empty if none required.';
      currentValue = draft?.apiKey ? '********' : '';
    }

    return (
      <Box borderStyle="round" borderColor={getBorderColor()} paddingX={1} flexDirection="column">
        <Text color="cyan" bold underline>
          {getHeader()}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{description}</Text>
          {currentValue && (
            <Box marginTop={1}>
              <Text color="yellow">Current draft value: </Text>
              <Text color="white">{currentValue}</Text>
            </Box>
          )}
          {errorMessage && (
            <Box marginTop={1}>
              <Text color="red">⚠ {errorMessage}</Text>
            </Box>
          )}
        </Box>
        <Box
          marginTop={1}
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        >
          <Text color="gray" dimColor>
            {getFooter()}
          </Text>
        </Box>
      </Box>
    );
  };

  // Text wizard steps are rendered differently
  if (phase === 'wizard_name' || phase === 'wizard_url' || phase === 'wizard_key') {
    return renderTextWizardPrompt();
  }

  const labelColumnWidth = (() => {
    let maxLen = 0;
    for (const it of activeItems) {
      let p = '  ';
      let l = it.label;
      if (it.kind === 'add-provider') {
        p = '+ ';
      } else if (it.kind === 'action') {
        p = it.tone === 'destructive' ? '× ' : '  ';
      } else if (it.kind === 'field' && it.detail) {
        l = `${it.label}: ${it.detail}`;
      }
      maxLen = Math.max(maxLen, p.length + l.length);
    }
    return maxLen + 2;
  })();

  return (
    <Box flexDirection="column">
      <Box marginBottom={0}>
        <Text color="cyan" bold underline>
          {getHeader()}
        </Text>
      </Box>
      {phase === 'confirm_delete' && (
        <Box marginTop={1} marginBottom={0}>
          <Text color="red" bold>
            ⚠ WARNING: Are you sure you want to delete this provider? This action cannot be undone.
          </Text>
        </Box>
      )}
      {phase === 'confirm_discard' && (
        <Box marginTop={1} marginBottom={0}>
          <Text color="yellow" bold>
            ⚠ You have unsaved changes. Discard them?
          </Text>
        </Box>
      )}
      {errorMessage && phase !== 'edit_fields' && (
        <Box marginTop={1} marginBottom={0}>
          <Text color="red">⚠ {errorMessage}</Text>
        </Box>
      )}
      <MenuContainer
        items={activeItems}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        borderColor={getBorderColor()}
        footer={getFooter()}
        isInactive={(item) => item.kind === 'provider' && item.id === 'codex'}
        renderItem={(item, index, isSelected, isInactive) => {
          let label = item.label;
          let prefix = '  ';
          let suffix = '';
          let color = isSelected ? 'green' : 'white';
          let bold = isSelected;

          if (item.kind === 'provider') {
            // Built-in (non-active): greyed out, not actionable on Enter.
            // Custom providers remain bright so they look interactive.
            // Note: openai and openrouter remain active/bright because we can change their api key.
            color = isInactive ? 'gray' : isSelected ? 'green' : 'white';
            suffix = item.label === 'Codex' ? 'Run `npx @openai/codex login` to login to Codex' : '';
          } else if (item.kind === 'add-provider') {
            prefix = '+ ';
            color = isSelected ? 'green' : 'yellow';
          } else if (item.kind === 'action') {
            prefix = item.tone === 'destructive' ? '× ' : '  ';
            color = item.tone === 'destructive' ? (isSelected ? 'red' : 'red') : isSelected ? 'green' : 'white';
            bold = isSelected || item.tone === 'destructive';
          } else if (item.kind === 'field' || item.kind === 'type') {
            prefix = '  ';
            if (item.kind === 'field' && item.detail) {
              label = `${item.label}: ${item.detail}`;
            }
          }

          const isDestructive = item.kind === 'action' && item.tone === 'destructive';
          if (isDestructive) {
            color = isSelected ? 'red' : 'red';
          }

          if (phase === 'edit_fields' && item.kind === 'field') {
            const error = item.fieldKey ? fieldErrors?.[item.fieldKey] : undefined;
            return (
              <Box key={`${index}-${item.kind}-${item.label}`} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
                  <Box width={labelColumnWidth} flexDirection="row" flexShrink={0}>
                    <Text color={color} bold={bold}>
                      {prefix}
                      {label}
                    </Text>
                  </Box>
                  {suffix ? <Text color="gray">{suffix}</Text> : null}
                </Box>
                {error ? (
                  <Box marginLeft={4}>
                    <Text color="red">⚠ {error}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          }

          return (
            <Box key={`${index}-${item.kind}-${item.label}`} flexDirection="row">
              <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
              <Box width={labelColumnWidth} flexDirection="row" flexShrink={0}>
                <Text color={color} bold={bold}>
                  {prefix}
                  {label}
                </Text>
              </Box>
              {suffix ? <Text color="gray">{suffix}</Text> : null}
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default ProviderSelectionMenu;
