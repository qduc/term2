import * as nodeFileSystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadMcpConfig } from './mcp-config.js';
export class McpConfigController {
    userConfigPath;
    workspaceRoot;
    replaceServers;
    onNote;
    fileSystem;
    temporaryPath;
    loadConfig;
    constructor(options) {
        this.userConfigPath = options.userConfigPath;
        this.workspaceRoot = options.workspaceRoot;
        this.replaceServers = options.replaceServers;
        this.onNote = options.onNote;
        this.fileSystem = options.fileSystem ?? nodeFileSystem;
        this.temporaryPath = options.temporaryPath ?? ((path) => `${path}.${randomUUID()}.tmp`);
        this.loadConfig = options.loadConfig ?? loadMcpConfig;
    }
    async readRoot() {
        let contents;
        try {
            contents = await this.fileSystem.readFile(this.userConfigPath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return {};
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(contents);
        }
        catch (error) {
            throw new Error(`${this.userConfigPath} is not valid JSON: ${error.message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`${this.userConfigPath} must contain a JSON object`);
        }
        const root = parsed;
        if (root.mcpServers !== undefined &&
            (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers))) {
            throw new Error(`${this.userConfigPath}: "mcpServers" must be an object`);
        }
        return root;
    }
    async listUserServers() {
        const root = await this.readRoot();
        return Object.entries(root.mcpServers ?? {}).flatMap(([name, config]) => config && typeof config === 'object' && !Array.isArray(config)
            ? [{ name, config: config }]
            : []);
    }
    async saveUserServer(originalName, name, config) {
        const trimmedName = name.trim();
        if (!trimmedName)
            throw new Error('Server name is required.');
        const root = await this.readRoot();
        const servers = { ...(root.mcpServers ?? {}) };
        if (originalName !== null && originalName !== trimmedName)
            delete servers[originalName];
        if (originalName !== trimmedName && Object.hasOwn(servers, trimmedName)) {
            throw new Error(`An MCP server named "${trimmedName}" already exists.`);
        }
        servers[trimmedName] = config;
        await this.persistAndReload({ ...root, mcpServers: servers });
    }
    async deleteUserServer(name) {
        const root = await this.readRoot();
        const servers = { ...(root.mcpServers ?? {}) };
        delete servers[name];
        await this.persistAndReload({ ...root, mcpServers: servers });
    }
    async persistAndReload(root) {
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
//# sourceMappingURL=mcp-config-controller.js.map