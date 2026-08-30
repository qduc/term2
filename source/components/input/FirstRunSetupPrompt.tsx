import React from 'react';
import { Box, Text } from 'ink';
import { getProviderLabel } from '../../providers/provider-service.js';
import { COLOR_ACCENT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

export type FirstRunSetupPhase = 'provider' | 'model';

export type FirstRunSetupPromptProps = {
  phase: FirstRunSetupPhase;
  provider: string;
};

export function FirstRunSetupPrompt({ phase, provider }: FirstRunSetupPromptProps) {
  const providerLabel = getProviderLabel(provider) ?? provider;

  return (
    <Box borderStyle="round" borderColor={COLOR_ACCENT} paddingX={1} flexDirection="column">
      <Text color={COLOR_ACCENT} bold>
        First-run setup
      </Text>
      {phase === 'provider' ? (
        <>
          <Text>Choose a provider and configure its credentials to start chatting.</Text>
          {provider === 'codex' ? (
            <Text color={COLOR_WARNING}>
              Codex is not logged in on this host. Run `term2 --codex-login`, then reselect Codex to retry.
            </Text>
          ) : (
            <Text color={COLOR_WARNING}>
              Select {providerLabel} to enter its API key, or choose another provider. Credential presence is checked
              locally.
            </Text>
          )}
        </>
      ) : (
        <Text>
          Credentials found for {providerLabel}. Choose a model to finish setup; typed custom model IDs are accepted.
        </Text>
      )}
      <Text color={COLOR_TEXT_SUBTLE}>Normal chat is disabled until setup completes.</Text>
    </Box>
  );
}

export default FirstRunSetupPrompt;
