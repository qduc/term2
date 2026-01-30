import { Runner } from '@openai/agents';
import { registerProvider } from '../registry.js';
import { GitHubCopilotProvider } from './provider.js';
import { isCopilotCliAvailable, isGhAuthenticated } from './utils.js';

/**
 * Fetch available models from GitHub Copilot.
 * The SDK exposes available models at runtime.
 */
async function fetchGitHubCopilotModels(
    deps: { settingsService: any; loggingService: any },
    _fetchImpl?: (url: string, options?: any) => Promise<any>,
): Promise<Array<{ id: string; name?: string }>> {
    const { loggingService } = deps;

    // Check if Copilot CLI is available
    if (!isCopilotCliAvailable()) {
        loggingService.warn('GitHub Copilot CLI not available - cannot fetch models');
        return [];
    }

    if (!isGhAuthenticated()) {
        loggingService.warn('GitHub CLI not authenticated - cannot fetch models');
        return [];
    }

    try {
        // Import dynamically to avoid issues if SDK not installed
        const { CopilotClient } = await import('@github/copilot-sdk');
        const client = new CopilotClient();

        await client.start();
        const models = await client.listModels();

        // Clean up client after fetching models
        await client.stop();

        return models.map((model: { id: string; name?: string }) => ({
            id: model.id,
            name: model.name || model.id,
        }));
    } catch (err: any) {
        loggingService.error('Failed to fetch GitHub Copilot models', {
            error: err.message,
        });

        // Return default models as fallback
        return [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
            { id: 'gpt-5', name: 'GPT-5' },
        ];
    }
}

// Register GitHub Copilot provider
registerProvider({
    id: 'github-copilot',
    label: 'GitHub Copilot',
    createRunner: ({ settingsService, loggingService }) => {
        // Check if Copilot CLI is available
        if (!isCopilotCliAvailable()) {
            loggingService.warn(
                'GitHub Copilot CLI not available. Run `gh extension install github/gh-copilot` to install.',
            );
            return null;
        }

        if (!isGhAuthenticated()) {
            loggingService.warn(
                'GitHub CLI not authenticated. Run `gh auth login` to authenticate.',
            );
            return null;
        }

        return new Runner({
            modelProvider: new GitHubCopilotProvider({
                settingsService,
                loggingService,
            }),
        });
    },
    fetchModels: fetchGitHubCopilotModels,
    sensitiveSettingKeys: [],
});
