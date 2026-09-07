import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SECRET_KEY = /^(apiKey|api_key|key|token|authorization|secret|password|refresh_token|access_token|id_token)$/i;

export function realSettingsPath() {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'term2-nodejs', 'settings.json');
}

export function realConfigDir() {
  return process.env.TERM2_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'term2-nodejs');
}

export function projectMemoryId(projectPath) {
  return createHash('sha256').update(path.resolve(projectPath)).digest('hex');
}

export function createEphemeralAuthState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-stage1-auth-'));
  fs.chmodSync(root, 0o700);
  return root;
}

export function destroyEphemeralAuthState(root) {
  if (!root) return;
  fs.rmSync(root, { recursive: true, force: true });
}

export function writeIsolatedSettings({ sourcePath, destPath, memoryDirectory, pin }) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const data = JSON.parse(raw);
  data.memory = { ...(data.memory ?? {}), directory: memoryDirectory };
  data.logging = { ...(data.logging ?? {}), debugLogging: true, logLevel: 'debug' };
  data.app = {
    ...(data.app ?? {}),
    liteMode: false,
    planMode: false,
    mentorMode: false,
    orchestratorMode: false,
    searchViaShell: (data.app && data.app.searchViaShell) || 'auto',
  };
  data.enable_agent_workflow = false;
  data.sandbox = { ...(data.sandbox ?? {}), enabled: pin?.['sandbox.enabled'] ?? true };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(destPath, 0o600);
  return summarizeSettings(data);
}

export function harvestLogs(ephemeralState, destLogs) {
  const src = path.join(ephemeralState, 'term2-nodejs', 'logs');
  if (!fs.existsSync(src)) return null;
  fs.cpSync(src, destLogs, { recursive: true });
  return destLogs;
}

export function summarizeSettings(data) {
  const providers = Array.isArray(data.providers)
    ? data.providers.map((provider) => ({
        id: provider?.id ?? null,
        type: provider?.type ?? null,
        name: provider?.name ?? null,
        hasCredential: Object.keys(provider ?? {}).some((key) => SECRET_KEY.test(key) && Boolean(provider[key])),
      }))
    : [];
  return {
    agentProvider: data.agent?.provider ?? null,
    agentModel: data.agent?.model ?? null,
    providerIds: providers.map((provider) => provider.id),
    providers,
    memoryDirectory: data.memory?.directory ?? null,
    sandboxEnabled: data.sandbox?.enabled ?? null,
    searchViaShell: data.app?.searchViaShell ?? null,
    liteMode: data.app?.liteMode ?? null,
    planMode: data.app?.planMode ?? null,
    mentorMode: data.app?.mentorMode ?? null,
    orchestratorMode: data.app?.orchestratorMode ?? null,
    enableAgentWorkflow: data.enable_agent_workflow ?? null,
    loggingLogLevel: data.logging?.logLevel ?? null,
    loggingDebug: data.logging?.debugLogging ?? null,
  };
}

export function cellEnv({ cellRoot, configDir, ephemeralState }) {
  const xdgData = path.join(cellRoot, 'xdg-data');
  const conversations = path.join(cellRoot, 'conversations');
  const memory = path.join(cellRoot, 'memory');
  const tmp = path.join(cellRoot, 'tmp');
  const logs = path.join(cellRoot, 'logs');
  for (const dir of [xdgData, conversations, memory, tmp, logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    env: {
      XDG_STATE_HOME: ephemeralState,
      XDG_DATA_HOME: xdgData,
      TERM2_CONVERSATIONS_DIR: conversations,
      TERM2_CONFIG_DIR: configDir,
      TERM2_RAW_TRAFFIC: '1',
      LOG_LEVEL: 'debug',
      DEBUG_LOGGING: '1',
      TMPDIR: tmp,
    },
    paths: { ephemeralState, xdgData, conversations, memory, tmp, logs },
  };
}

export function copyWorkspace(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}
