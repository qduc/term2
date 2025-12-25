import {registerProvider} from './registry.js';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

async function fetchOpenAIModels(
    _deps: {settingsService: any; loggingService: any},
    fetchImpl: (url: string, options?: any) => Promise<any> = fetch as any,
): Promise<Array<{id: string; name?: string}>> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(OPENAI_MODELS_URL, {headers});
    if (!response.ok) {
        throw new Error(`OpenAI models request failed (${response.status})`);
    }

    const body = await response.json();
    const raw = body?.data || [];

    if (!Array.isArray(raw)) return [];

    return raw
        .map((item: any) => {
            const id = item?.id || item?.model || '';
            const name = item?.name || item?.display_name || item?.description;
            return id ? {id, name} : null;
        })
        .filter(Boolean) as Array<{id: string; name?: string}>;
}

// Register OpenAI provider
registerProvider({
    id: 'openai',
    label: 'OpenAI',
    createRunner: undefined, // Use SDK default
    fetchModels: fetchOpenAIModels,
    clearConversations: undefined, // No conversation state to clear
    sensitiveSettingKeys: [],
});
