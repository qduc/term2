/** Port of legacy source/components/input/FirstRunSetupPrompt.tsx; the provider label comes from the session. */
import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../presentation/components/theme.js';
import { useSkin } from '../presentation/skins/SkinContext.js';
import type { FirstRunSetupPhase } from './use-first-run-setup.js';

export type FirstRunSetupPromptProps = {
  phase: FirstRunSetupPhase;
  provider: string;
  providerLabel: string | undefined;
};

export function FirstRunSetupPrompt({ phase, provider, providerLabel }: FirstRunSetupPromptProps) {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  const label = providerLabel ?? provider;

  return (
    <MenuFrame title="First-run setup" borderColor={theme.accent} hasItems={false} footerPlacement="outside">
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
                : `Select a provider to configure its credentials. If it is not listed, choose Add Provider and select its template.`}
            </Text>
          )}
        </>
      ) : (
        <Text>Provider {label} is ready. Choose a model to finish setup; typed custom model IDs are accepted.</Text>
      )}
      <Text color={theme.textSubtle}>Normal chat is disabled until setup completes.</Text>
    </MenuFrame>
  );
}
