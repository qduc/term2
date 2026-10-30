import { z } from 'zod';
import { getAllProviders } from '../../providers/index.js';
import { isProviderDisabled, resolveProviderCredentials } from '../../utils/ai/provider-credentials.js';
import { loadProviderModelGroup } from '../../services/models/model-listing.js';
const parameters = z.object({
    provider: z.string().optional().describe('Exact registered provider ID. Omit to search all providers.'),
    provider_query: z
        .string()
        .optional()
        .describe('Filter provider IDs/labels before any catalog load. Use this instead of query when searching for a provider.'),
    view: z
        .enum(['models', 'providers'])
        .optional()
        .describe('Default models. providers lists registration/readiness only, without loading catalogs or history.'),
    query: z.string().optional().describe('Case-insensitive substring of provider ID/label or model ID/name.'),
    include_history: z
        .boolean()
        .optional()
        .describe('Default false for name sort, true for usage/recency. False skips session indexing and returns null counts.'),
    include_names: z
        .boolean()
        .optional()
        .describe('Include display names. Default false for compact results; IDs are always returned.'),
    limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Model page size, default 50. Omitted models remain retrievable with offset; no hidden maximum.'),
    offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Model page offset, default 0. Repeat the same filters/sort with nextOffset to retrieve more; live catalog/history changes may reorder pages.'),
    sort: z
        .enum(['name', 'usage', 'recency'])
        .optional()
        .describe('Default recency. Usage counts recorded project sessions, not API calls; recency is their latest update.'),
});
export const modelDiscoveryResultSchema = z.object({
    history: z.object({
        status: z.enum(['available', 'partial', 'unavailable', 'not-requested']),
        scope: z.string().nullable(),
        unavailableSessions: z.number().nullable(),
        note: z.string(),
    }),
    providers: z.array(z.object({
        id: z.string(),
        label: z.string(),
        disabled: z.boolean(),
        credentialsConfigured: z.boolean(),
        supportsStreamedModel: z.boolean(),
        catalogStatus: z.enum(['loaded', 'failed', 'not-ready', 'not-requested']),
    })),
    models: z.array(z.object({
        provider: z.string(),
        id: z.string(),
        name: z.string().optional(),
        sessionCount: z.number().nullable(),
        lastSessionUpdatedAt: z.string().nullable(),
    })),
    totalModels: z.number(),
    offset: z.number(),
    nextOffset: z.number().nullable(),
});
/** Discover registered provider/model IDs without exposing credentials or dispatching a model.
 * History is a project session-metadata proxy, not invocation telemetry or proof of reachability.
 */
export function createListModelsToolDefinition(deps) {
    return {
        name: 'list_models',
        description: 'Discover actual runtime provider/model IDs before choosing a subagent model. Start with view: providers for a cheap registration/readiness listing (no catalog/history I/O), then use exact provider or provider_query to narrow catalog loads. Catalog listing may contact configured providers; never invokes a model. query filters loaded models, not provider fetches. Models are compact pages of 50; use nextOffset with the same inputs for more, or set limit. Names are opt-in. Sort by name (skips history by default), recorded project session count (usage), or latest session update (recency, default). History excludes unrecorded switches and is not invocation telemetry. Discovery grants no permission to invoke a provider/model and does not prove reachability or model-specific compatibility.',
        parameters,
        scriptedReturnSchema: modelDiscoveryResultSchema,
        parallelSafe: true,
        needsApproval: () => false,
        formatCommandMessage: () => [],
        execute: async ({ provider, provider_query, view = 'models', query, sort = 'recency', include_history, include_names = false, limit = 50, offset = 0, }, context) => {
            const runtimeSignal = context?.signal;
            const configuredSignal = deps.catalogDeps?.signal;
            const signal = runtimeSignal && configuredSignal
                ? AbortSignal.any([runtimeSignal, configuredSignal])
                : runtimeSignal ?? configuredSignal;
            const wantsHistory = view === 'models' && (include_history ?? sort !== 'name');
            const historyPromise = wantsHistory
                ? Promise.resolve()
                    .then(() => deps.getHistory?.())
                    .catch(() => null)
                : Promise.resolve(null);
            const providerNeedle = provider_query?.trim().toLowerCase() ?? '';
            const entries = getAllProviders()
                .filter((entry) => (!provider || entry.id === provider) && `${entry.id} ${entry.label}`.toLowerCase().includes(providerNeedle))
                .sort((a, b) => a.id.localeCompare(b.id));
            const loaded = await Promise.all(entries.map(async (entry) => {
                const disabled = isProviderDisabled(deps.settingsService, entry.id);
                const credentialsConfigured = resolveProviderCredentials(deps.settingsService, entry.id).configured;
                const supportsStreamedModel = Boolean(entry.createStreamedModel);
                const ready = !disabled && credentialsConfigured && supportsStreamedModel;
                const group = view === 'models' && ready
                    ? await loadProviderModelGroup({ ...deps, ...deps.catalogDeps, signal }, entry.id)
                    : null;
                return { entry, disabled, credentialsConfigured, supportsStreamedModel, group };
            }));
            const history = (await historyPromise) ?? null;
            const uses = new Map();
            for (const session of history?.sessions ?? []) {
                if (!session.provider || !session.model)
                    continue;
                const key = JSON.stringify([session.provider, session.model]);
                const use = uses.get(key) ?? { count: 0, updatedAt: null };
                use.count++;
                if (Number.isFinite(Date.parse(session.updatedAt)) &&
                    (!use.updatedAt || Date.parse(session.updatedAt) > Date.parse(use.updatedAt)))
                    use.updatedAt = session.updatedAt;
                uses.set(key, use);
            }
            const result = {
                history: {
                    status: !wantsHistory
                        ? 'not-requested'
                        : history
                            ? history.unavailable
                                ? 'partial'
                                : 'available'
                            : 'unavailable',
                    scope: history?.scope ?? null,
                    unavailableSessions: history?.unavailable ?? null,
                    note: 'Counts associate saved sessions with their recorded provider/model; recency is session updatedAt, not last model invocation. Missing history is null; partial counts are lower bounds. Model switches and subagents without saved sessions are not counted.',
                },
                providers: [],
                models: [],
                totalModels: 0,
                offset,
                nextOffset: null,
            };
            const needle = query?.trim().toLowerCase() ?? '';
            for (const { entry, disabled, credentialsConfigured, supportsStreamedModel, group } of loaded) {
                const providerMatches = `${entry.id} ${entry.label}`.toLowerCase().includes(needle);
                const models = (group?.models ?? []).filter((model) => !model.unavailableReason &&
                    (providerMatches || `${model.id} ${model.name ?? ''}`.toLowerCase().includes(needle)));
                result.providers.push({
                    id: entry.id,
                    label: entry.label,
                    disabled,
                    credentialsConfigured,
                    supportsStreamedModel,
                    catalogStatus: view === 'providers' ? 'not-requested' : group ? (group.error ? 'failed' : 'loaded') : 'not-ready',
                });
                for (const model of models) {
                    const use = uses.get(JSON.stringify([entry.id, model.id]));
                    result.models.push({
                        provider: entry.id,
                        id: model.id,
                        ...(include_names && model.name ? { name: model.name } : {}),
                        sessionCount: history ? use?.count ?? 0 : null,
                        lastSessionUpdatedAt: use?.updatedAt ?? null,
                    });
                }
            }
            result.models.sort((a, b) => {
                if (sort === 'usage' && a.sessionCount !== b.sessionCount)
                    return (b.sessionCount ?? -1) - (a.sessionCount ?? -1);
                if (sort !== 'name' && a.lastSessionUpdatedAt !== b.lastSessionUpdatedAt)
                    return (Date.parse(b.lastSessionUpdatedAt ?? '') || 0) - (Date.parse(a.lastSessionUpdatedAt ?? '') || 0);
                return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
            });
            result.totalModels = result.models.length;
            result.models = result.models.slice(offset, offset + limit);
            result.nextOffset = offset + result.models.length < result.totalModels ? offset + result.models.length : null;
            return result;
        },
    };
}
//# sourceMappingURL=list-models.js.map