import { Runner } from '@openai/agents';
import { registerProvider } from '../registry.js';
import { getClient } from './model.js';
import { GitHubCopilotProvider } from './provider.js';
import {
    isCopilotCliAvailable,
    isGhAuthenticated,
    isCopilotCliAvailableAsync,
    isGhAuthenticatedAsync,
} from './utils.js';

let modelsCache: Array<{ id: string; name?: string }> | null = null;

/**
 * Fetch available models from GitHub Copilot.
 * The SDK exposes available models at runtime.
 */
async function fetchGitHubCopilotModels(
    deps: { settingsService: any; loggingService: any },
    _fetchImpl?: (url: string, options?: any) => Promise<any>,
): Promise<Array<{ id: string; name?: string }>> {
    const { loggingService } = deps;

    // Return cached models if available
    if (modelsCache) {
        return modelsCache;
    }

    // Check if Copilot CLI is available
    if (!(await isCopilotCliAvailableAsync())) {
        const error =
            'GitHub Copilot CLI not available. Install it via `npm install -g @github/copilot-cli` or `gh extension install github/gh-copilot`.';
        loggingService.warn(error);
        throw new Error(error);
    }

    if (!(await isGhAuthenticatedAsync())) {
        const error =
            'GitHub Copilot CLI not authenticated. Run `copilot auth` or `gh auth login` to authenticate.';
        loggingService.warn(error);
        throw new Error(error);
    }

    try {
        const client = await getClient();
        const models = await client.listModels();

        modelsCache = models.map((model: { id: string; name?: string }) => ({
            id: model.id,
            name: model.name || model.id,
        }));

        return modelsCache;
    } catch (err: any) {
        loggingService.error('Failed to fetch GitHub Copilot models', {
            error: err.message,
        });

        // Return default models as fallback but don't cache them permanently
        return [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
            { id: 'o1-preview', name: 'O1 Preview' },
            { id: 'o1-mini', name: 'O1 Mini' },
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
                'GitHub Copilot CLI not available. Install it via `npm install -g @github/copilot-cli` or `gh extension install github/gh-copilot`.',
            );
            return null;
        }

        if (!isGhAuthenticated()) {
            loggingService.warn(
                'GitHub Copilot CLI not authenticated. Run `copilot auth` or `gh auth login` to authenticate.',
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
