import { resolveSettingsDirectory } from '../../../../source/services/settings/settings-path.js';
import { SettingsService } from '../../../../source/services/settings/settings-service.js';
import { isDeepStrictEqual } from 'node:util';
const pairedServices = new WeakMap();
const bindingOrigins = new WeakMap();
export function forkAdoptedSettingsBinding(settings, service, initial) {
    const origin = bindingOrigins.get(settings);
    if (!origin || pairedServices.get(settings) !== service)
        throw new Error('Expected paired adopted settings');
    return origin.source.forSessionBinding(origin.scope, origin.overrides, initial);
}
export function isAdoptedSettingsPair(settings, service) {
    return pairedServices.get(settings) === service;
}
export function createAdoptedSettings(options = {}) {
    const { writeMode = 'persistent', ...serviceOptions } = options;
    const service = new SettingsService({
        ...serviceOptions,
        // Match the old CLI's XDG_STATE_HOME / platform / home directory behavior.
        settingsDir: serviceOptions.settingsDir ?? resolveSettingsDirectory(),
    });
    return { service, source: new AdoptedSettingsSource(service, writeMode) };
}
/** Bridges the rewrite config contract to the existing settings owner. */
export class AdoptedSettingsSource {
    service;
    writeMode;
    constructor(service, writeMode = 'persistent') {
        this.service = service;
        this.writeMode = writeMode;
    }
    forSession(scope, overrides = new Map()) {
        return this.forSessionBinding(scope, overrides).settings;
    }
    forSessionBinding(scope, overrides = new Map(), runtimeInitial) {
        const readable = new Set(scope.readable);
        const writable = new Set(scope.writable);
        // Each session owns its own copy. A caller can safely reuse or mutate its
        // input map after this point without changing another session's view.
        const sessionOverrides = new Map([...overrides].map(([key, value]) => [key, snapshot(value)]));
        if (runtimeInitial) {
            sessionOverrides.set('agent.modelSelection', snapshot(runtimeInitial.selection));
            sessionOverrides.set('agent.reasoningEffort', runtimeInitial.reasoningEffort);
            sessionOverrides.set('agent.temperature', runtimeInitial.temperature);
        }
        const watchers = new Set();
        const sourceWatchers = new Set();
        const beneath = (child, parent) => child.startsWith(`${parent}.`);
        const directlyAuthorized = (key) => [...readable].some((allowed) => key === allowed || beneath(key, allowed));
        const sourceGet = (key) => {
            const authorized = directlyAuthorized(key);
            const descendants = [...readable].filter((allowed) => beneath(allowed, key));
            if (!authorized && descendants.length === 0)
                return undefined;
            let value = authorized ? snapshot(this.service.getDynamic(key)) : undefined;
            const ancestors = [...sessionOverrides.entries()]
                .filter(([path]) => key === path || beneath(key, path))
                .sort(([left], [right]) => left.length - right.length);
            for (const [path, override] of ancestors)
                value = nestedValue(override, key.slice(path.length).replace(/^\./, ''));
            if (!authorized) {
                value = {};
                for (const path of descendants) {
                    const child = sourceGet(path);
                    if (child !== undefined)
                        value = withNestedValue(value, path.slice(key.length + 1), child);
                }
            }
            else {
                const children = [...sessionOverrides.entries()]
                    .filter(([path]) => beneath(path, key) && directlyAuthorized(path))
                    .sort(([left], [right]) => left.length - right.length);
                for (const [path, override] of children)
                    value = withNestedValue(value, path.slice(key.length + 1), override);
            }
            return snapshot(value);
        };
        const get = (key) => (readable.has(key) ? sourceGet(key) : undefined);
        const notify = (watcher) => {
            for (const key of readable) {
                const previous = watcher.lastSeen.get(key);
                const next = snapshot(get(key));
                if (isDeepStrictEqual(previous, next))
                    continue;
                watcher.lastSeen.set(key, next);
                try {
                    watcher.listener({ key, previous, next });
                }
                catch {
                    /* Source settings observers are passive. */
                }
            }
        };
        const watch = (listener) => {
            const lastSeen = new Map();
            for (const key of readable)
                lastSeen.set(key, snapshot(get(key)));
            const watcher = { listener, lastSeen };
            watchers.add(watcher);
            const unsubscribeService = this.service.onChange(() => notify(watcher));
            return () => {
                watchers.delete(watcher);
                unsubscribeService();
            };
        };
        const notifySource = (watcher) => {
            const changed = [];
            for (const key of readable) {
                const next = snapshot(get(key));
                if (isDeepStrictEqual(watcher.lastSeen.get(key), next))
                    continue;
                watcher.lastSeen.set(key, next);
                changed.push(key);
            }
            if (changed.length) {
                try {
                    watcher.listener(changed.length === 1 ? changed[0] : undefined);
                }
                catch {
                    /* Source observers are passive. */
                }
            }
        };
        const watchSource = (listener) => {
            const lastSeen = new Map();
            for (const key of readable)
                lastSeen.set(key, snapshot(get(key)));
            const watcher = { listener, lastSeen };
            sourceWatchers.add(watcher);
            const unsubscribe = this.service.onChange(() => notifySource(watcher));
            return () => {
                sourceWatchers.delete(watcher);
                unsubscribe();
            };
        };
        const setSync = (key, value, mode = this.writeMode) => {
            if (!writable.has(key))
                throw new Error(`Setting '${key}' is not writable in this session`);
            if ([...sessionOverrides.keys()].some((path) => path === key || beneath(key, path))) {
                sessionOverrides.set(key, snapshot(value));
                for (const watcher of watchers)
                    notify(watcher);
                for (const watcher of sourceWatchers)
                    notifySource(watcher);
                return;
            }
            if (mode === 'runtime') {
                this.service.setDynamic(key, value, { persist: false });
                return;
            }
            const result = this.service.setPersistentDynamic(key, value);
            if (result.status !== 'saved') {
                throw new Error(`Setting '${key}' was not persisted (${result.reason})`);
            }
        };
        const settings = {
            get,
            watch,
            async set(key, value) {
                setSync(key, value);
            },
        };
        const service = {
            get: (key) => sourceGet(key),
            getDynamic: (key) => sourceGet(key),
            getSource: (key) => !directlyAuthorized(key) && ![...readable].some((path) => beneath(path, key))
                ? 'default'
                : [...sessionOverrides.keys()].some((path) => path === key || beneath(key, path) || (beneath(path, key) && directlyAuthorized(path)))
                    ? 'cli'
                    : this.service.getSource(key),
            set: (key, value, options) => setSync(key, value, options?.persist === false ? 'runtime' : this.writeMode),
            setDynamic: (key, value, options) => setSync(key, value, options?.persist === false ? 'runtime' : this.writeMode),
            setPersistent: (key, value) => setSync(key, value, 'persistent'),
            setPersistentDynamic: (key, value) => setSync(key, value, 'persistent'),
            onChange: watchSource,
        };
        pairedServices.set(settings, service);
        bindingOrigins.set(settings, {
            source: this,
            scope: { readable: [...readable], writable: [...writable] },
            overrides: new Map([...overrides].map(([key, value]) => [key, snapshot(value)])),
        });
        const setRuntimeOverride = (mutation) => {
            if (!runtimeInitial)
                throw new Error('Not a runtime-owned settings binding');
            const [key, value] = mutation.kind === 'model'
                ? ['agent.modelSelection', mutation.selection]
                : mutation.kind === 'reasoning'
                    ? ['agent.reasoningEffort', mutation.effort]
                    : ['agent.temperature', mutation.temperature];
            sessionOverrides.set(key, snapshot(value));
            // The exact client setter below owns the only refresh for this change.
        };
        return { settings, service, setRuntimeOverride };
    }
}
function snapshot(value) {
    return value !== undefined && typeof value === 'object' && value !== null ? structuredClone(value) : value;
}
function nestedValue(value, path) {
    if (!path)
        return value;
    return path
        .split('.')
        .reduce((current, part) => current && typeof current === 'object' ? current[part] : undefined, value);
}
function withNestedValue(value, path, next) {
    const copy = value && typeof value === 'object' && !Array.isArray(value)
        ? structuredClone(value)
        : {};
    const parts = path.split('.');
    let cursor = copy;
    for (const part of parts.slice(0, -1)) {
        const existing = cursor[part];
        cursor[part] =
            existing && typeof existing === 'object' && !Array.isArray(existing)
                ? { ...existing }
                : {};
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = structuredClone(next);
    return copy;
}
//# sourceMappingURL=settings.js.map