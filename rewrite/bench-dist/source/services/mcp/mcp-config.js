/**
 * Config loading for MCP servers (plan Decision 4 + the M1-connection brief).
 *
 * Sources: user `mcp.json` next to term2's settings directory and project
 * `<workspace root>/.mcp.json`. A user entry wins over a clashing project
 * entry; `${VAR}` expansion runs against the process environment for user
 * config only, so a repository can never route a secret to a URL it chose.
 * Invalid entries resolve to config errors — the connection manager turns
 * those into `failed` snapshots — so one bad line never blocks startup.
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { resolveSettingsDirectory } from '../settings/settings-path.js';
const USER_CONFIG_FILE_NAME = 'mcp.json';
const PROJECT_CONFIG_FILE_NAME = '.mcp.json';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const expandValue = (value, env) => value.replace(ENV_PATTERN, (_whole, name) => env[name] ?? '');
/** Relative cwd paths run against the config file's context, never term2's process cwd. */
const resolveCwd = (cwd, cwdBase) => (isAbsolute(cwd) ? cwd : resolve(cwdBase, cwd));
const asStringRecord = (value) => {
    if (!isRecord(value))
        return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (typeof v !== 'string')
            return undefined;
        out[k] = v;
    }
    return out;
};
const EMPTY_SOURCE = { entries: new Map(), projectOverrides: new Map(), nonInteractiveAllow: [] };
/** Canonical form for opt-in matching; falls back to the input when the path does not exist. */
export const realpathOrSelf = (path) => {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
};
const parseSourceFile = (sourceName, contents, note) => {
    let root;
    try {
        root = JSON.parse(contents);
    }
    catch (error) {
        note(`${sourceName} is not valid JSON and was ignored: ${error.message}`);
        return EMPTY_SOURCE;
    }
    if (!isRecord(root)) {
        note(`${sourceName} is not a JSON object and was ignored.`);
        return EMPTY_SOURCE;
    }
    const entries = new Map();
    const rawServers = root.mcpServers;
    if (rawServers !== undefined) {
        if (!isRecord(rawServers)) {
            note(`${sourceName}: "mcpServers" is not an object and was ignored.`);
        }
        else {
            for (const [name, entry] of Object.entries(rawServers))
                entries.set(name, entry);
        }
    }
    const projectOverrides = new Map();
    const nonInteractiveAllow = Array.isArray(root.nonInteractiveAllow)
        ? root.nonInteractiveAllow.filter((value) => typeof value === 'string')
        : [];
    const rawOverrides = root.projectServers;
    if (rawOverrides !== undefined) {
        if (!isRecord(rawOverrides)) {
            note(`${sourceName}: "projectServers" is not an object and was ignored.`);
        }
        else {
            for (const [rootPath, servers] of Object.entries(rawOverrides)) {
                // Keys are workspace roots: relative paths must never be resolved
                // against term2's process cwd, so they are ignored with a note.
                if (!isAbsolute(rootPath)) {
                    note(`${sourceName}: "projectServers.${rootPath}" is not an absolute path and was ignored.`);
                    continue;
                }
                if (!isRecord(servers)) {
                    note(`${sourceName}: "projectServers.${rootPath}" is not an object and was ignored.`);
                    continue;
                }
                const byName = new Map();
                for (const [name, value] of Object.entries(servers)) {
                    if (isRecord(value) && typeof value.enabled === 'boolean') {
                        byName.set(name, { enabled: value.enabled });
                    }
                }
                projectOverrides.set(rootPath, byName);
            }
        }
    }
    return { entries, projectOverrides, nonInteractiveAllow };
};
const resolveEntry = (name, provenance, entry, env, 
/** User config expands `${VAR}`; project config is literal. */
expandVariables, projectEnabledOverride, 
/** Relative `cwd` resolves against this: the config file's workspace (project) or settings dir (user). */
cwdBase) => {
    const fail = (error) => ({
        name,
        provenance,
        // Nothing is inferable when the entry itself is malformed; the manager
        // never launches an errored entry, so this placeholder is inert.
        transport: 'stdio',
        projectEnabledOverride,
        error,
    });
    if (!isRecord(entry))
        return fail('entry is not an object');
    const rawType = entry.type;
    if (rawType !== undefined && rawType !== 'stdio' && rawType !== 'http' && rawType !== 'sse') {
        return fail(`unknown type ${JSON.stringify(rawType)} (expected stdio, http, or sse)`);
    }
    const rawCommand = entry.command;
    const rawUrl = entry.url;
    if (rawCommand !== undefined && typeof rawCommand !== 'string')
        return fail('command must be a string');
    if (rawUrl !== undefined && typeof rawUrl !== 'string')
        return fail('url must be a string');
    let type = rawType;
    if (type === undefined)
        type = rawCommand !== undefined ? 'stdio' : rawUrl !== undefined ? 'http' : undefined;
    if (type === undefined)
        return fail('needs a command (stdio) or a url (http/sse)');
    if (type === 'stdio' && rawCommand === undefined)
        return fail('type "stdio" requires a command');
    if (type !== 'stdio' && rawUrl === undefined)
        return fail(`type "${type}" requires a url`);
    const rawArgs = entry.args;
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string'))) {
        return fail('args must be an array of strings');
    }
    const rawEnv = asStringRecord(entry.env);
    if (entry.env !== undefined && rawEnv === undefined)
        return fail('env must be an object of strings');
    const rawHeaders = asStringRecord(entry.headers);
    if (entry.headers !== undefined && rawHeaders === undefined)
        return fail('headers must be an object of strings');
    const rawCwd = entry.cwd;
    if (rawCwd !== undefined && typeof rawCwd !== 'string')
        return fail('cwd must be a string');
    const rawClientId = entry.clientId;
    if (rawClientId !== undefined && typeof rawClientId !== 'string')
        return fail('clientId must be a string');
    const rawClientMetadataUrl = entry.clientMetadataUrl;
    if (rawClientMetadataUrl !== undefined && typeof rawClientMetadataUrl !== 'string') {
        return fail('clientMetadataUrl must be a string');
    }
    const rawRedirectPorts = entry.redirectPorts;
    if (rawRedirectPorts !== undefined &&
        (!Array.isArray(rawRedirectPorts) ||
            rawRedirectPorts.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535))) {
        return fail('redirectPorts must be an array of port numbers');
    }
    const expandArg = (value) => (expandVariables ? expandValue(value, env) : value);
    const transport = type === 'http' ? 'streamable-http' : type;
    return {
        name,
        provenance,
        transport,
        ...(rawCommand !== undefined ? { command: expandArg(rawCommand) } : {}),
        ...(rawArgs !== undefined ? { args: rawArgs.map(expandArg) } : {}),
        ...(rawEnv !== undefined
            ? { env: Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, expandArg(v)])) }
            : {}),
        ...(rawCwd !== undefined ? { cwd: resolveCwd(expandArg(rawCwd), cwdBase) } : {}),
        ...(rawUrl !== undefined ? { url: expandArg(rawUrl) } : {}),
        ...(rawHeaders !== undefined
            ? { headers: Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k, expandArg(v)])) }
            : {}),
        ...(rawClientMetadataUrl !== undefined ? { clientMetadataUrl: expandArg(rawClientMetadataUrl) } : {}),
        ...(rawClientId !== undefined ? { clientId: expandArg(rawClientId) } : {}),
        ...(rawRedirectPorts !== undefined ? { redirectPorts: rawRedirectPorts } : {}),
        projectEnabledOverride,
    };
};
export async function loadMcpConfig(options = {}) {
    const notes = [];
    const note = (message) => {
        notes.push(message);
        options.onNote?.(message);
    };
    const read = options.files ?? ((path) => readFile(path, 'utf8'));
    const env = options.env ?? process.env;
    const settingsDir = options.settingsDir ?? resolveSettingsDirectory();
    const workspaceRoot = options.workspaceRoot ?? getActiveWorkspaceRoot();
    const userConfigPath = join(settingsDir, USER_CONFIG_FILE_NAME);
    const projectConfigPath = join(workspaceRoot, PROJECT_CONFIG_FILE_NAME);
    const loadSource = async (path, sourceName) => {
        let contents;
        try {
            contents = await read(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return EMPTY_SOURCE;
            note(`${sourceName} could not be read and was ignored: ${error.message}`);
            return EMPTY_SOURCE;
        }
        return parseSourceFile(sourceName, contents, note);
    };
    const user = await loadSource(userConfigPath, userConfigPath);
    const project = await loadSource(projectConfigPath, projectConfigPath);
    // Opt-in matching compares the real path of the workspace with the real path
    // of each projectServers key, so a symlinked session root still matches.
    const workspaceKey = realpathOrSelf(workspaceRoot);
    const servers = [];
    for (const [name, entry] of user.entries) {
        servers.push(resolveEntry(name, 'user', entry, env, true, undefined, settingsDir));
    }
    for (const [name, entry] of project.entries) {
        if (user.entries.has(name)) {
            note(`project server "${name}" from ${projectConfigPath} was dropped: a user entry with the same name wins.`);
            continue;
        }
        let projectEnabledOverride;
        for (const [rootPath, byName] of user.projectOverrides) {
            if (realpathOrSelf(rootPath) === workspaceKey)
                projectEnabledOverride = byName.get(name)?.enabled;
        }
        servers.push(resolveEntry(name, 'project', entry, env, false, projectEnabledOverride, workspaceRoot));
    }
    return { servers, notes, userConfigPath, nonInteractiveAllow: user.nonInteractiveAllow };
}
//# sourceMappingURL=mcp-config.js.map