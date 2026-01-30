import { type ModelProvider, type Model } from '@openai/agents-core';
import type { CopilotSession } from '@github/copilot-sdk';
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import { GitHubCopilotDirectModel } from './model-direct.js';

/**
 * GitHubCopilotProvider - Uses the Direct model that lets Copilot SDK
 * control tool execution flow without trying to integrate with
 * OpenAI Agents SDK's approval pattern.
 */
export class GitHubCopilotProvider implements ModelProvider {
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;
    #sessionMap = new Map<string, string>(); // Mapping of responseId -> sessionId
    #activeSessions = new Map<string, CopilotSession>(); // Cache of sessionId -> actual session object

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
    }) {
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
    }

    getModel(modelName?: string): Promise<Model> | Model {
        return new GitHubCopilotDirectModel({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
            modelId: modelName,
            sessionMap: this.#sessionMap,
            activeSessions: this.#activeSessions,
        });
    }
}

// Export factory function for dependency injection
export function createGitHubCopilotProvider(deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}): GitHubCopilotProvider {
    return new GitHubCopilotProvider(deps);
}
