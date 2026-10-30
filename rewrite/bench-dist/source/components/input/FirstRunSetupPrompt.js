import React from 'react';
import { Text } from 'ink';
import { getProviderLabel } from '../../providers/provider-service.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
export function FirstRunSetupPrompt({ phase, provider }) {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    const providerLabel = getProviderLabel(provider) ?? provider;
    return (React.createElement(MenuFrame, { title: "First-run setup", borderColor: theme.accent, hasItems: false, footerPlacement: "outside" },
        phase === 'provider' ? (React.createElement(React.Fragment, null,
            React.createElement(Text, null, "Choose a provider and configure its credentials to start chatting."),
            provider === 'codex' ? (React.createElement(Text, { color: theme.warning }, "Codex is not logged in on this host. Run `term2 --codex-login`, then reselect Codex to retry.")) : (React.createElement(Text, { color: theme.warning }, provider === 'grok'
                ? 'Log in to Grok in your browser with `term2 --grok-login`, then reselect Grok.'
                : `Select a provider to configure its credentials. If it is not listed, choose Add Provider and select its template.`)))) : (React.createElement(Text, null,
            "Provider ",
            providerLabel,
            " is ready. Choose a model to finish setup; typed custom model IDs are accepted.")),
        React.createElement(Text, { color: theme.textSubtle }, "Normal chat is disabled until setup completes.")));
}
export default FirstRunSetupPrompt;
//# sourceMappingURL=FirstRunSetupPrompt.js.map