import {type ModelProvider, type Model} from '@openai/agents-core';
import type {ILoggingService, ISettingsService} from '../../services/service-interfaces.js';
import {OpenAICompatibleModel} from './model.js';

export type CustomProviderConfig = {
    name: string;
    baseUrl: string;
    apiKey?: string;
};

function findCustomProviderConfig(settingsService: ISettingsService, providerId: string): CustomProviderConfig | null {
    const list = settingsService.get<any>('providers');
    if (!Array.isArray(list)) return null;

    const entry = list.find((p: any) => p && p.name === providerId);
    if (!entry) return null;

    return {
        name: String(entry.name),
        baseUrl: String(entry.baseUrl),
        apiKey: entry.apiKey ? String(entry.apiKey) : undefined,
    };
}

export class OpenAICompatibleProvider implements ModelProvider {
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;
    #providerId: string;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        providerId: string;
    }) {
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#providerId = deps.providerId;
    }

    getModel(modelName?: string): Promise<Model> | Model {
        const config = findCustomProviderConfig(this.#settingsService, this.#providerId);
        if (!config) {
            throw new Error(
                `Custom provider '${this.#providerId}' is not configured. ` +
                `Please add it to settings.json under \"providers\".`
            );
        }

        return new OpenAICompatibleModel({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
            providerId: this.#providerId,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelId: modelName,
        });
    }
}

export function createOpenAICompatibleProvider(deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
    providerId: string;
}): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider(deps);
}
