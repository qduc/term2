import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  RUNTIME_MODIFIABLE_SETTINGS,
} from '../../source/services/settings/settings-schema.js';
import { getSettingMetadata } from '../../source/services/settings/settings-ui-metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDocPath = path.join(__dirname, '../src/content/docs/reference/settings.md');

// Helper to evaluate dot-paths against evaluated DEFAULT_SETTINGS object
function getPath(obj: any, keyPath: string): any {
  if (obj == null || typeof obj !== 'object') return undefined;
  const parts = keyPath.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

// Known environment variable mappings from settings-env.ts and provider-credentials.ts
const ENV_VAR_MAP: Record<string, string> = {
  'agent.openai.apiKey': 'OPENAI_API_KEY',
  'agent.openrouter.apiKey': 'OPENROUTER_API_KEY',
  'agent.openrouter.baseUrl': 'OPENROUTER_BASE_URL',
  'agent.openrouter.referrer': 'OPENROUTER_REFERRER',
  'agent.openrouter.title': 'OPENROUTER_TITLE',
  'agent.model': 'OPENROUTER_MODEL',
  'logging.logLevel': 'LOG_LEVEL',
  'logging.disableLogging': 'DISABLE_LOGGING',
  'logging.debugLogging': 'DEBUG_LOGGING',
  'environment.nodeEnv': 'NODE_ENV',
  'app.shellPath': 'SHELL',
  'tools.logFileOperations': 'LOG_FILE_OPERATIONS',
  'debug.debugBashTool': 'DEBUG_BASH_TOOL',
  'webSearch.tavily.apiKey': 'TAVILY_API_KEY',
  'webSearch.exa.apiKey': 'EXA_API_KEY',
  'webSearch.provider': 'WEB_SEARCH_PROVIDER',
};

// Formatter for evaluated default values
function formatDefaultValue(key: string, val: any): string {
  if (val === undefined) return '—';
  if (val === null) return '`null`';
  if (typeof val === 'string') {
    // For path defaults containing user home directories, generalize to portable path
    if (key === 'memory.directory') {
      return '`~/.local/share/term2-nodejs/memory`';
    }
    return `\`"${val}"\``;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return `\`${val}\``;
  }
  if (Array.isArray(val)) {
    return `\`${JSON.stringify(val)}\``;
  }
  if (typeof val === 'object') {
    return `\`${JSON.stringify(val)}\``;
  }
  return `\`${String(val)}\``;
}

interface SettingEntry {
  key: string;
  type: string;
  defaultValue: string;
  description: string;
  isRuntimeModifiable: boolean;
  envVar: string;
}

const allKeys = Object.values(SETTING_KEYS) as string[];
const entries: SettingEntry[] = [];

for (const key of allKeys) {
  const meta = getSettingMetadata(key as any);
  const rawDefault = getPath(DEFAULT_SETTINGS, key);
  const formattedDefault = formatDefaultValue(key, rawDefault);

  let typeStr = 'string';
  if (meta?.enumOptions && meta.enumOptions.length > 0) {
    typeStr = meta.enumOptions.join(' \\| ');
  } else if (meta?.isArray) {
    typeStr = 'array';
  } else if (meta?.type) {
    typeStr = meta.type;
  } else if (typeof rawDefault === 'boolean') {
    typeStr = 'boolean';
  } else if (typeof rawDefault === 'number') {
    typeStr = 'number';
  }

  const isRuntimeModifiable = RUNTIME_MODIFIABLE_SETTINGS.has(key);
  const description = meta?.description || 'No description available.';
  const envVar = ENV_VAR_MAP[key] || '—';

  entries.push({
    key,
    type: typeStr,
    defaultValue: formattedDefault,
    description,
    isRuntimeModifiable,
    envVar,
  });
}

// Group entries into logical documentation categories
const categories: Record<string, SettingEntry[]> = {
  'Agent & Models': [],
  'Run Budget & Safeguards': [],
  'Subagents & Roles': [],
  'Shell & Sandbox': [],
  'Context & Compaction': [],
  'Tools & Permissions': [],
  'UI & Terminal': [],
  'Memory & Skills': [],
  'Logging & Debug': [],
  'SSH & Remote': [],
  'Web Search': [],
  'Hooks & Environment': [],
};

for (const entry of entries) {
  const key = entry.key;
  if (key.startsWith('agent.runBudget.')) {
    categories['Run Budget & Safeguards'].push(entry);
  } else if (key.startsWith('agent.subagent') || key.startsWith('subagent.')) {
    categories['Subagents & Roles'].push(entry);
  } else if (key.startsWith('agent.contextCompaction.') || key.startsWith('agent.sessionRollover.')) {
    categories['Context & Compaction'].push(entry);
  } else if (key.startsWith('shell.') || key.startsWith('sandbox.')) {
    categories['Shell & Sandbox'].push(entry);
  } else if (key.startsWith('agent.')) {
    categories['Agent & Models'].push(entry);
  } else if (key.startsWith('tools.')) {
    categories['Tools & Permissions'].push(entry);
  } else if (key.startsWith('ui.') || key.startsWith('app.')) {
    categories['UI & Terminal'].push(entry);
  } else if (key.startsWith('memory.')) {
    categories['Memory & Skills'].push(entry);
  } else if (key.startsWith('logging.') || key.startsWith('debug.')) {
    categories['Logging & Debug'].push(entry);
  } else if (key.startsWith('ssh.')) {
    categories['SSH & Remote'].push(entry);
  } else if (key.startsWith('webSearch.')) {
    categories['Web Search'].push(entry);
  } else {
    categories['Hooks & Environment'].push(entry);
  }
}

// Validation assertions to guarantee factual correctness on every generation
const compactionEntry = entries.find((e) => e.key === 'agent.contextCompaction.enabled');
if (!compactionEntry || compactionEntry.defaultValue !== '`false`') {
  throw new Error(`Validation failed: agent.contextCompaction.enabled must default to false, got ${compactionEntry?.defaultValue}`);
}

const rolloverMilestones = entries.find((e) => e.key === 'agent.sessionRollover.milestones');
if (!rolloverMilestones || rolloverMilestones.defaultValue !== '`[200000,300000,400000]`') {
  throw new Error(`Validation failed: agent.sessionRollover.milestones must be [200000,300000,400000], got ${rolloverMilestones?.defaultValue}`);
}

const turnBackstop = entries.find((e) => e.key === 'agent.runBudget.turnBackstop');
if (!turnBackstop || turnBackstop.type !== 'number' || turnBackstop.defaultValue !== '`150`') {
  throw new Error(`Validation failed: agent.runBudget.turnBackstop must be number 150, got ${turnBackstop?.type} ${turnBackstop?.defaultValue}`);
}

const autoApproveMode = entries.find((e) => e.key === 'shell.autoApproveMode');
if (!autoApproveMode || autoApproveMode.defaultValue !== '`"off"`' || !autoApproveMode.type.includes('always')) {
  throw new Error(`Validation failed: shell.autoApproveMode must default to off and include always in types, got ${autoApproveMode?.type} ${autoApproveMode?.defaultValue}`);
}

const sshEnabled = entries.find((e) => e.key === 'ssh.enabled');
const sshPort = entries.find((e) => e.key === 'ssh.port');
if (!sshEnabled || sshEnabled.defaultValue !== '`false`' || !sshPort || sshPort.defaultValue !== '`22`' || sshPort.type !== 'number') {
  throw new Error(`Validation failed: ssh.enabled must be false, ssh.port must be number 22`);
}

const webSearchProvider = entries.find((e) => e.key === 'webSearch.provider');
if (!webSearchProvider || webSearchProvider.defaultValue !== '`"tavily"`') {
  throw new Error(`Validation failed: webSearch.provider must default to tavily, got ${webSearchProvider?.defaultValue}`);
}

// Build Markdown Output
let markdown = `---
title: Settings Reference
description: Complete reference of term2 configuration settings, defaults, runtime modifiability, and environment variables.
---

> **Auto-generated Reference:** This page is generated directly by evaluating \`DEFAULT_SETTINGS\`, schema definitions, and metadata from \`source/services/settings/\`. Run \`pnpm --dir website build\` to re-extract settings.

term2 settings can be configured via:
1. **Interactive Settings Menu**: Run \`/settings\` or \`/settings <key>\` in the interactive TUI.
2. **Configuration File**: Stored in \`settings.json\` in your platform's application state directory.
3. **Environment Variables**: Overrides for API keys, logging, and environment options.

## Modifying Settings

- In interactive mode: type \`/settings <key> <value>\` or browse with \`/settings\`.
- Settings marked as **Runtime Modifiable** can be changed mid-session without restarting.
- Non-runtime modifiable settings require restarting term2 to take effect.
- Reset any setting to its default in the settings menu using \`Ctrl+D\`.

---
`;

for (const [categoryName, categoryEntries] of Object.entries(categories)) {
  if (categoryEntries.length === 0) continue;
  markdown += `\n## ${categoryName}\n\n`;
  markdown += `| Key | Type | Default | Runtime Modifiable | Environment Variable | Description |\n`;
  markdown += `| :--- | :--- | :--- | :---: | :--- | :--- |\n`;

  for (const entry of categoryEntries) {
    const modifiableBadge = entry.isRuntimeModifiable ? '✓ Yes' : 'No';
    const envBadge = entry.envVar !== '—' ? `\`${entry.envVar}\`` : '—';
    markdown += `| \`${entry.key}\` | \`${entry.type}\` | ${entry.defaultValue} | ${modifiableBadge} | ${envBadge} | ${entry.description} |\n`;
  }
}

fs.writeFileSync(targetDocPath, markdown, 'utf8');
console.log(`Successfully generated settings reference at ${targetDocPath} (${entries.length} keys extracted and validated against DEFAULT_SETTINGS).`);
