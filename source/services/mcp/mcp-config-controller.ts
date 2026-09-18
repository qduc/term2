import * as nodeFileSystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadMcpConfig, type ResolvedMcpServerConfig } from './mcp-config.js';

export type RawMcpServerConfig = Record<string, unknown>;
export type McpConfigFileSystem = Pick<typeof nodeFileSystem, 'readFile' | 'mkdir' | 'writeFile' | 'rename'>;

export interface McpConfigControllerOptions {
  userConfigPath: string;
  workspaceRoot: string;
  replaceServers: (servers: readonly ResolvedMcpServerConfig[]) => Promise<void>;
  onNote?: (message: string) => void;
  fileSystem?: McpConfigFileSystem;
  temporaryPath?: (userConfigPath: string) => string;
  loadConfig?: typeof loadMcpConfig;
}

type UserConfigRoot = Record<string, unknown> & { mcpServers?: Record<string, unknown> };

export class McpConfigController {
  readonly userConfigPath: string;
  private readonly workspaceRoot: string;
  private readonly replaceServers: McpConfigControllerOptions['replaceServers'];
  private readonly onNote?: (message: string) => void;
  private readonly fileSystem: McpConfigFileSystem;
  private readonly temporaryPath: (userConfigPath: string) => string;
  private readonly loadConfig: typeof loadMcpConfig;

  constructor(options: McpConfigControllerOptions) {
    this.userConfigPath = options.userConfigPath;
    this.workspaceRoot = options.workspaceRoot;
    this.replaceServers = options.replaceServers;
    this.onNote = options.onNote;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.temporaryPath = options.temporaryPath ?? ((path) => `${path}.${randomUUID()}.tmp`);
    this.loadConfig = options.loadConfig ?? loadMcpConfig;
  }

  private async readRoot(): Promise<UserConfigRoot> {
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(this.userConfigPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`${this.userConfigPath} is not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.userConfigPath} must contain a JSON object`);
    }
    const root = parsed as UserConfigRoot;
    if (
      root.mcpServers !== undefined &&
      (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers))
    ) {
      throw new Error(`${this.userConfigPath}: "mcpServers" must be an object`);
    }
    return root;
  }

  async listUserServers(): Promise<readonly { name: string; config: RawMcpServerConfig }[]> {
    const root = await this.readRoot();
    return Object.entries(root.mcpServers ?? {}).flatMap(([name, config]) =>
      config && typeof config === 'object' && !Array.isArray(config)
        ? [{ name, config: config as RawMcpServerConfig }]
        : [],
    );
  }

  async saveUserServer(originalName: string | null, name: string, config: RawMcpServerConfig): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Server name is required.');
    const root = await this.readRoot();
    const servers = { ...(root.mcpServers ?? {}) };
    if (originalName !== null && originalName !== trimmedName) delete servers[originalName];
    if (originalName !== trimmedName && Object.hasOwn(servers, trimmedName)) {
      throw new Error(`An MCP server named "${trimmedName}" already exists.`);
    }
    servers[trimmedName] = config;
    await this.persistAndReload({ ...root, mcpServers: servers });
  }

  async deleteUserServer(name: string): Promise<void> {
    const root = await this.readRoot();
    const servers = { ...(root.mcpServers ?? {}) };
    delete servers[name];
    await this.persistAndReload({ ...root, mcpServers: servers });
  }

  private async persistAndReload(root: UserConfigRoot): Promise<void> {
    const directory = dirname(this.userConfigPath);
    await this.fileSystem.mkdir(directory, { recursive: true });
    const temporary = this.temporaryPath(this.userConfigPath);
    await this.fileSystem.writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
    await this.fileSystem.rename(temporary, this.userConfigPath);
    const loaded = await this.loadConfig({
      settingsDir: directory,
      workspaceRoot: this.workspaceRoot,
      ...(this.onNote ? { onNote: this.onNote } : {}),
    });
    await this.replaceServers(loaded.servers);
  }
}
