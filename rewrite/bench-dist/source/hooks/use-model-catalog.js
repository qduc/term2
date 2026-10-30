import { useEffect, useState } from 'react';
/**
 * Shared catalog state for composer and pool model menus. Publish each provider
 * independently: a pending or failed catalog must never hide healthy results.
 * Closing/reopening or refreshing detaches the previous load's callbacks.
 */
export function useModelCatalog({ active, session, providerIds, refreshKey, }) {
    const [catalogs, setCatalogs] = useState(() => new Map());
    const [loading, setLoading] = useState(false);
    const [warning, setWarning] = useState(null);
    useEffect(() => {
        if (!active)
            return;
        session.begin();
        let disposed = false;
        let remaining = providerIds.length;
        const failures = [];
        /* eslint-disable react-hooks/set-state-in-effect */
        setCatalogs(new Map(providerIds.map((id) => [id, session.getCached(id) ?? []])));
        setWarning(null);
        setLoading(remaining > 0);
        /* eslint-enable react-hooks/set-state-in-effect */
        for (const providerId of providerIds) {
            void session
                .load(providerId)
                .then((result) => {
                if (disposed || result.kind === 'stale')
                    return;
                const models = result.models.map((model) => ({ ...model, provider: model.provider || providerId }));
                setCatalogs((current) => new Map(current).set(providerId, models));
            })
                .catch(() => {
                if (disposed)
                    return;
                failures.push(providerId);
                // Report failures immediately, even if another provider never settles.
                setWarning(`Some providers failed: ${failures.join(', ')}`);
            })
                .finally(() => {
                remaining -= 1;
                if (!disposed && remaining === 0)
                    setLoading(false);
            });
        }
        return () => {
            disposed = true;
        };
    }, [active, session, providerIds, refreshKey]);
    return { catalogs, loading, warning };
}
//# sourceMappingURL=use-model-catalog.js.map