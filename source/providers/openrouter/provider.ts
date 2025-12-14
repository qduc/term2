import {type ModelProvider, type Model} from '@openai/agents-core';
import type {ILoggingService, ISettingsService} from '../../services/service-interfaces.js';
import {OpenRouterModel} from './model.js';

export class OpenRouterProvider implements ModelProvider {
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
        return new OpenRouterModel({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
            modelId: modelName,
        });
    }
}

// Export factory function for dependency injection
export function createOpenRouterProvider(deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}): OpenRouterProvider {
    return new OpenRouterProvider(deps);
}
