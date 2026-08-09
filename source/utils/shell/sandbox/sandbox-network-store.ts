import fs from 'node:fs';
import { getActiveWorkspaceRoot } from '../../../services/workspace/active-workspace-root.js';
import path from 'node:path';

const PROJECT_CONFIG_DIR = '.term2';
const PROJECT_NETWORK_HOSTS_FILE = 'sandbox-network-hosts.json';

type ProjectNetworkHostsFile = {
  version: number;
  allowHosts: string[];
};

export class SessionNetworkAllowStore {
  #allowedHosts = new Set<string>();

  add(hostOrHostPort: string): void {
    this.#allowedHosts.add(hostOrHostPort.toLowerCase());
  }

  isAllowed(host: string, port?: number): boolean {
    const lowerHost = host.toLowerCase();
    if (this.#allowedHosts.has(lowerHost)) return true;
    if (port != null && this.#allowedHosts.has(`${lowerHost}:${port}`)) return true;
    return false;
  }

  clear(): void {
    this.#allowedHosts.clear();
  }
}

export class ProjectNetworkAllowStore {
  #workspaceRoot: string;
  #fs: typeof fs;

  constructor(workspaceRoot: string, fileSystem: typeof fs = fs) {
    this.#workspaceRoot = workspaceRoot;
    this.#fs = fileSystem;
  }

  get #configPath(): string {
    return path.join(this.#workspaceRoot, PROJECT_CONFIG_DIR, PROJECT_NETWORK_HOSTS_FILE);
  }

  load(): string[] {
    try {
      if (!this.#fs.existsSync(this.#configPath)) return [];
      const raw = this.#fs.readFileSync(this.#configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectNetworkHostsFile>;
      if (!parsed || !Array.isArray(parsed.allowHosts)) return [];
      return Array.from(
        new Set(parsed.allowHosts.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())),
      );
    } catch {
      return [];
    }
  }

  isAllowed(host: string, port?: number): boolean {
    const hosts = this.load();
    const lowerHost = host.toLowerCase();
    if (hosts.includes(lowerHost)) return true;
    if (port != null && hosts.includes(`${lowerHost}:${port}`)) return true;
    return false;
  }

  append(hostOrHostPort: string): void {
    const normalized = hostOrHostPort.toLowerCase();
    const current = this.load();
    if (current.includes(normalized)) return;
    const next = [...current, normalized];
    this.#write(next);
  }

  #write(hosts: string[]): void {
    const dir = path.dirname(this.#configPath);
    this.#fs.mkdirSync(dir, { recursive: true });
    const payload: ProjectNetworkHostsFile = { version: 1, allowHosts: hosts };
    this.#fs.writeFileSync(this.#configPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }
}

export const sessionNetworkAllowStore = new SessionNetworkAllowStore();

let projectNetworkAllowStore: ProjectNetworkAllowStore | null = null;
let projectNetworkAllowStoreRoot: string | null = null;

export function getProjectNetworkAllowStore(workspaceRoot: string): ProjectNetworkAllowStore {
  if (!projectNetworkAllowStore || projectNetworkAllowStoreRoot !== workspaceRoot) {
    projectNetworkAllowStore = new ProjectNetworkAllowStore(workspaceRoot);
    projectNetworkAllowStoreRoot = workspaceRoot;
  }
  return projectNetworkAllowStore;
}

export function isHostAllowed(host: string, port?: number, workspaceRoot: string = getActiveWorkspaceRoot()): boolean {
  if (sessionNetworkAllowStore.isAllowed(host, port)) return true;
  return getProjectNetworkAllowStore(workspaceRoot).isAllowed(host, port);
}

export function addAllowedHost(
  host: string,
  port: number | undefined,
  scope: 'session' | 'project',
  workspaceRoot: string = getActiveWorkspaceRoot(),
): void {
  const entry = port != null && port !== 80 && port !== 443 ? `${host}:${port}` : host;
  if (scope === 'session') {
    sessionNetworkAllowStore.add(entry);
  } else if (scope === 'project') {
    getProjectNetworkAllowStore(workspaceRoot).append(entry);
  }
}

export function resetSandboxNetworkStoreForTest(): void {
  sessionNetworkAllowStore.clear();
  projectNetworkAllowStore = null;
  projectNetworkAllowStoreRoot = null;
}
