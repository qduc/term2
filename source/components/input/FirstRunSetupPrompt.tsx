import React from 'react';
import { Box, Text } from 'ink';
import { getProviderLabel } from '../../providers/provider-service.js';
import { useTheme } from '../theme.js';

export type FirstRunSetupPhase = 'provider' | 'model';

export type FirstRunSetupPromptProps = {
  phase: FirstRunSetupPhase;
  provider: string;
};

export function FirstRunSetupPrompt({ phase, provider }: FirstRunSetupPromptProps) {
  const theme = useTheme();
  const providerLabel = getProviderLabel(provider) ?? provider;

  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
      <Text color={theme.accent} bold>
        First-run setup
      </Text>
      {phase === 'provider' ? (
        <>
          <Text>Choose a provider and configure its credentials to start chatting.</Text>
          {provider === 'codex' ? (
            <Text color={theme.warning}>
              Codex is not logged in on this host. Run `term2 --codex-login`, then reselect Codex to retry.
            </Text>
          ) : (
            <Text color={theme.warning}>
              {provider === 'grok'
                ? 'Log in to Grok in your browser with `term2 --grok-login`, then reselect Grok.'
                : `Select ${providerLabel} to enter its API key, or choose another provider.`}
            </Text>
          )}
        </>
      ) : (
        <Text>
          Credentials found for {providerLabel}. Choose a model to finish setup; typed custom model IDs are accepted.
        </Text>
      )}
      <Text color={theme.textSubtle}>Normal chat is disabled until setup completes.</Text>
    </Box>
  );
}

export default FirstRunSetupPrompt;
