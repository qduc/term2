import { type ModelProvider, type Model } from '@openai/agents-core';
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import { GitHubCopilotModel } from './model.js';

export class GitHubCopilotProvider implements ModelProvider {
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
    }) {
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
    }

    getModel(modelName?: string): Promise<Model> | Model {
        return new GitHubCopilotModel({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
            modelId: modelName,
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
