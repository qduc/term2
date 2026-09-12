import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const schemaPath = path.join(rootDir, 'source/services/settings/settings-schema.ts');
const metadataPath = path.join(rootDir, 'source/services/settings/settings-ui-metadata.ts');
const envPath = path.join(rootDir, 'source/services/settings/settings-env.ts');
const targetDocPath = path.join(__dirname, '../src/content/docs/reference/settings.md');

// 1. Read files
const schemaSrc = fs.readFileSync(schemaPath, 'utf8');
const metadataSrc = fs.readFileSync(metadataPath, 'utf8');
const envSrc = fs.readFileSync(envPath, 'utf8');

// 2. Parse SETTING_KEYS
const keysBlockMatch = schemaSrc.match(/export const SETTING_KEYS = \{([\s\S]*?)\};/);
if (!keysBlockMatch) {
  throw new Error('Could not find SETTING_KEYS in settings-schema.ts');
}
const keyRegex = /([A-Z0-9_]+):\s*['"]([^'"]+)['"]/g;
const settingKeys = [];
let m;
while ((m = keyRegex.exec(keysBlockMatch[1])) !== null) {
  settingKeys.push({ symbol: m[1], key: m[2] });
}

// 3. Parse RUNTIME_MODIFIABLE_SETTINGS
const runtimeModifiableBlock = schemaSrc.match(
  /export const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>\(\[([\s\S]*?)\]\);/,
);
const runtimeModifiableKeys = new Set();
if (runtimeModifiableBlock) {
  const rmRegex = /SETTING_KEYS\.([A-Z0-9_]+)/g;
  let rmMatch;
  while ((rmMatch = rmRegex.exec(runtimeModifiableBlock[1])) !== null) {
    const found = settingKeys.find((k) => k.symbol === rmMatch[1]);
    if (found) runtimeModifiableKeys.add(found.key);
  }
}

// 4. Parse descriptions from settings-ui-metadata.ts
const descMap = new Map();
const fallbackDescBlock = metadataSrc.match(
  /const FALLBACK_SETTING_DESCRIPTIONS: Record<string, string> = \{([\s\S]*?)\};/,
);
if (fallbackDescBlock) {
  const descRegex = /\[SETTING_KEYS\.([A-Z0-9_]+)\]:\s*['"`]([\s\S]*?)['"`],/g;
  let descMatch;
  while ((descMatch = descRegex.exec(fallbackDescBlock[1])) !== null) {
    const symbol = descMatch[1];
    const text = descMatch[2].replace(/\s+/g, ' ').trim();
    const found = settingKeys.find((k) => k.symbol === symbol);
    if (found) descMap.set(found.key, text);
  }
}

// Also check schema inline .describe('...') calls
for (const item of settingKeys) {
  if (!descMap.has(item.key)) {
    const fieldName = item.key.split('.').pop();
    const fieldPattern = new RegExp(`${fieldName}:[\\s\\S]*?\\.describe\\(['"]([^'"]+)['"]\\)`);
    const fieldMatch = schemaSrc.match(fieldPattern);
    if (fieldMatch) {
      descMap.set(item.key, fieldMatch[1]);
    }
  }
}

// 5. Parse environment variable mappings
const envVarMap = new Map();
// Known mappings from settings-env.ts and provider-credentials.ts
const envMappings = [
  { env: 'OPENAI_API_KEY', key: 'agent.openai.apiKey' },
  { env: 'OPENROUTER_API_KEY', key: 'agent.openrouter.apiKey' },
  { env: 'OPENROUTER_BASE_URL', key: 'agent.openrouter.baseUrl' },
  { env: 'OPENROUTER_REFERRER', key: 'agent.openrouter.referrer' },
  { env: 'OPENROUTER_TITLE', key: 'agent.openrouter.title' },
  { env: 'OPENROUTER_MODEL', key: 'agent.model' },
  { env: 'LOG_LEVEL', key: 'logging.logLevel' },
  { env: 'DISABLE_LOGGING', key: 'logging.disableLogging' },
  { env: 'DEBUG_LOGGING', key: 'logging.debugLogging' },
  { env: 'NODE_ENV', key: 'environment.nodeEnv' },
  { env: 'SHELL', key: 'app.shellPath' },
  { env: 'LOG_FILE_OPERATIONS', key: 'tools.logFileOperations' },
  { env: 'DEBUG_BASH_TOOL', key: 'debug.debugBashTool' },
  { env: 'TAVILY_API_KEY', key: 'webSearch.tavily.apiKey' },
  { env: 'EXA_API_KEY', key: 'webSearch.exa.apiKey' },
  { env: 'WEB_SEARCH_PROVIDER', key: 'webSearch.provider' },
];
for (const map of envMappings) {
  envVarMap.set(map.key, map.env);
}

// 6. Parse default settings
// We can extract defaults by analyzing schema and default object patterns
function inferTypeAndDefault(key, symbol) {
  // Infer type based on schema or key pattern
  let type = 'string';
  let defaultValue = 'undefined';

  if (
    key.includes('Enabled') ||
    key.includes('enabled') ||
    key.startsWith('enable_') ||
    key.includes('useFlex') ||
    key.includes('useRtk') ||
    key.includes('autoBrief') ||
    key.includes('disableLogging') ||
    key.includes('debugLogging') ||
    key.includes('suppressConsole') ||
    key.includes('allowNetworking') ||
    key.includes('includeUserText') ||
    key.includes('includeToolArguments')
  ) {
    type = 'boolean';
  } else if (
    key.includes('Timeout') ||
    key.includes('timeout') ||
    key.includes('Tokens') ||
    key.includes('Turns') ||
    key.includes('Attempts') ||
    key.includes('Lines') ||
    key.includes('Chars') ||
    key.includes('Threshold') ||
    key.includes('Port') ||
    key.includes('size') ||
    key.includes('Size') ||
    key.includes('Ms') ||
    key.includes('Percent') ||
    key.includes('Micros') ||
    key.includes('temperature') ||
    key.includes('Limit') ||
    key.includes('Samples') ||
    key.includes('Calls')
  ) {
    type = 'number';
  } else if (
    key.includes('favoriteModels') ||
    key.includes('milestones') ||
    key.includes('allowReadExtra') ||
    key.includes('dockerHostControlProjects') ||
    key.includes('trustedProjectRoots') ||
    key.includes('mentorPool')
  ) {
    type = 'array';
  }

  // Look up default in DEFAULT_SETTINGS block
  const defaultBlockMatch = schemaSrc.match(/export const DEFAULT_SETTINGS: SettingsData = \{([\s\S]*?)\n\};/);
  if (defaultBlockMatch) {
    const leaf = key.split('.').pop();
    const leafRegex = new RegExp(`${leaf}:\\s*([^,\\n]+)`);
    const leafMatch = defaultBlockMatch[1].match(leafRegex);
    if (leafMatch) {
      defaultValue = leafMatch[1].trim();
      if (defaultValue.startsWith("'") || defaultValue.startsWith('"')) {
        defaultValue = `\`${defaultValue.slice(1, -1)}\``;
      }
    }
  }

  return { type, defaultValue };
}

// 7. Group keys into categories
const categories = {
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

for (const { symbol, key } of settingKeys) {
  const { type, defaultValue } = inferTypeAndDefault(key, symbol);
  const description = descMap.get(key) || 'No description available.';
  const isRuntimeModifiable = runtimeModifiableKeys.has(key);
  const envVar = envVarMap.get(key) || '—';

  const entry = {
    key,
    type,
    defaultValue,
    description,
    isRuntimeModifiable,
    envVar,
  };

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

// 8. Generate markdown document
let markdown = `---
title: Settings Reference
description: Complete reference of term2 configuration settings, defaults, runtime modifiability, and environment variables.
---

> **Auto-generated Reference:** This page is derived directly from \`source/services/settings/settings-schema.ts\` and \`settings-ui-metadata.ts\`. Run \`pnpm --dir website build\` to re-extract settings.

term2 settings can be configured via:
1. **Interactive Settings Menu**: Run \`/settings\` or \`/settings <key>\` in the interactive TUI.
2. **Configuration File**: Stored in \`settings.json\` in your platform's state directory.
3. **Environment Variables**: Overrides for API keys, logging, and environment options.

## Modifying Settings

- In interactive mode: type \`/settings <key> <value>\` or browse with \`/settings\`.
- Settings marked as **Runtime Modifiable** can be changed mid-session without restarting.
- Non-runtime modifiable settings require restarting term2 to take effect.
- Reset any setting to its default in the settings menu using \`Ctrl+D\`.

---
`;

for (const [categoryName, entries] of Object.entries(categories)) {
  if (entries.length === 0) continue;
  markdown += `\n## ${categoryName}\n\n`;
  markdown += `| Key | Type | Default | Runtime Modifiable | Environment Variable | Description |\n`;
  markdown += `| :--- | :--- | :--- | :---: | :--- | :--- |\n`;

  for (const entry of entries) {
    const modifiableBadge = entry.isRuntimeModifiable ? '✓ Yes' : 'No';
    const envBadge = entry.envVar !== '—' ? `\`${entry.envVar}\`` : '—';
    const def = entry.defaultValue !== 'undefined' ? entry.defaultValue : '—';
    markdown += `| \`${entry.key}\` | \`${entry.type}\` | ${def} | ${modifiableBadge} | ${envBadge} | ${entry.description} |\n`;
  }
}

fs.writeFileSync(targetDocPath, markdown, 'utf8');
console.log(`Successfully generated settings reference at ${targetDocPath} (${settingKeys.length} keys extracted).`);
