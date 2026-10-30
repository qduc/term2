import fs from 'node:fs';
import { getActiveWorkspaceRoot } from '../../../services/workspace/active-workspace-root.js';
import path from 'node:path';
const PROJECT_CONFIG_DIR = '.term2';
const PROJECT_NETWORK_HOSTS_FILE = 'sandbox-network-hosts.json';
export class SessionNetworkAllowStore {
    #allowedHosts = new Set();
    add(hostOrHostPort) {
        this.#allowedHosts.add(hostOrHostPort.toLowerCase());
    }
    isAllowed(host, port) {
        const lowerHost = host.toLowerCase();
        if (this.#allowedHosts.has(lowerHost))
            return true;
        if (port != null && this.#allowedHosts.has(`${lowerHost}:${port}`))
            return true;
        return false;
    }
    clear() {
        this.#allowedHosts.clear();
    }
}
export class ProjectNetworkAllowStore {
    #workspaceRoot;
    #fs;
    constructor(workspaceRoot, fileSystem = fs) {
        this.#workspaceRoot = workspaceRoot;
        this.#fs = fileSystem;
    }
    get #configPath() {
        return path.join(this.#workspaceRoot, PROJECT_CONFIG_DIR, PROJECT_NETWORK_HOSTS_FILE);
    }
    load() {
        try {
            if (!this.#fs.existsSync(this.#configPath))
                return [];
            const raw = this.#fs.readFileSync(this.#configPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.allowHosts))
                return [];
            return Array.from(new Set(parsed.allowHosts.filter((h) => typeof h === 'string').map((h) => h.toLowerCase())));
        }
        catch {
            return [];
        }
    }
    isAllowed(host, port) {
        const hosts = this.load();
        const lowerHost = host.toLowerCase();
        if (hosts.includes(lowerHost))
            return true;
        if (port != null && hosts.includes(`${lowerHost}:${port}`))
            return true;
        return false;
    }
    append(hostOrHostPort) {
        const normalized = hostOrHostPort.toLowerCase();
        const current = this.load();
        if (current.includes(normalized))
            return;
        const next = [...current, normalized];
        this.#write(next);
    }
    #write(hosts) {
        const dir = path.dirname(this.#configPath);
        this.#fs.mkdirSync(dir, { recursive: true });
        const payload = { version: 1, allowHosts: hosts };
        this.#fs.writeFileSync(this.#configPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }
}
export const sessionNetworkAllowStore = new SessionNetworkAllowStore();
let projectNetworkAllowStore = null;
let projectNetworkAllowStoreRoot = null;
export function getProjectNetworkAllowStore(workspaceRoot) {
    if (!projectNetworkAllowStore || projectNetworkAllowStoreRoot !== workspaceRoot) {
        projectNetworkAllowStore = new ProjectNetworkAllowStore(workspaceRoot);
        projectNetworkAllowStoreRoot = workspaceRoot;
    }
    return projectNetworkAllowStore;
}
export function isHostAllowed(host, port, workspaceRoot = getActiveWorkspaceRoot()) {
    if (sessionNetworkAllowStore.isAllowed(host, port))
        return true;
    return getProjectNetworkAllowStore(workspaceRoot).isAllowed(host, port);
}
export function addAllowedHost(host, port, scope, workspaceRoot = getActiveWorkspaceRoot()) {
    const entry = port != null && port !== 80 && port !== 443 ? `${host}:${port}` : host;
    if (scope === 'session') {
        sessionNetworkAllowStore.add(entry);
    }
    else if (scope === 'project') {
        getProjectNetworkAllowStore(workspaceRoot).append(entry);
    }
}
export function resetSandboxNetworkStoreForTest() {
    sessionNetworkAllowStore.clear();
    projectNetworkAllowStore = null;
    projectNetworkAllowStoreRoot = null;
}
//# sourceMappingURL=sandbox-network-store.js.map