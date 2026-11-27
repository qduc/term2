#!/usr/bin/env node
// Static surface-parity guard: keeps terminal (launch-tui) and web (launch-serve + src/host/server*.ts + web-client/)
// aligned across three surfaces:
//   1. App wiring: capabilities enabled in launch-tui.tsx that launch-serve.ts sets to false/null/undefined.
//   2. Protocol: SERVER_WIRE_COMMAND_PARITY (src/host/server-commands.ts) and WEB_WIRE_EVENT_PARITY
//      (web-client/lib/term2/session-store.ts), which tsc checks for exhaustiveness against WireCommand and WireEvent.
//   3. Settings: every browse-tab TUI setting in src/app/settings-completion-config.ts must appear in both
//      WEB_SETTINGS (src/config/settings/web-settings-policy.ts) and web-client's settings catalog, unless recorded.
//
// Every gap must be recorded in scripts/surface-parity-exceptions.json with { status: "deferred" | "by-design", reason }.
// Stale entries (for items now in parity or removed) fail the check so the manifest stays truthful.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { failureMap, reasonProblem, reportAndExit } from './gates/rules.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const exceptionsPath = path.join(scripts, 'surface-parity-exceptions.json');
const exceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));

const { map: failures, add } = failureMap();
const parity = add('surface-parity');

const parse = (relPath) => {
  const full = path.join(repo, relPath);
  return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
};

const propName = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
};

const VALID_STATUSES = new Set(['deferred', 'by-design']);

function readSectionExceptions(section) {
  const raw = exceptions[section];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    parity(`scripts/surface-parity-exceptions.json: missing object section "${section}"`);
    return new Map();
  }
  const map = new Map();
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      parity(`scripts/surface-parity-exceptions.json: ${section}.${key} must be an object { status, reason }`);
      continue;
    }
    if (!VALID_STATUSES.has(entry.status)) {
      parity(
        `scripts/surface-parity-exceptions.json: ${section}.${key} has invalid status "${entry.status}" (use "deferred" or "by-design")`,
      );
      continue;
    }
    const problem = reasonProblem(entry.reason);
    if (problem) {
      parity(`scripts/surface-parity-exceptions.json: ${section}.${key} ${problem}`);
      continue;
    }
    map.set(key, entry);
  }
  return map;
}

function checkExceptionAlignment(section, requiredGaps, knownUniverse) {
  const allowed = readSectionExceptions(section);
  for (const [key, detail] of requiredGaps) {
    if (!allowed.has(key)) {
      parity(`${section}.${key}: ${detail}`);
    }
  }
  for (const key of allowed.keys()) {
    if (!knownUniverse.has(key)) {
      parity(
        `scripts/surface-parity-exceptions.json: stale entry ${section}.${key} (no longer exists in source); delete it`,
      );
    } else if (!requiredGaps.has(key)) {
      parity(`scripts/surface-parity-exceptions.json: stale entry ${section}.${key} (now in parity); delete it`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. App wiring parity: launch-tui.tsx vs launch-serve.ts
// ---------------------------------------------------------------------------
function extractCreateDirectAppWiring(relPath) {
  const sf = parse(relPath);
  const topProps = new Map();
  const surfaceProps = new Map();
  let foundCall = false;

  const isDisabledExpr = (expr) => {
    if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(expr) && expr.text === 'undefined') return true;
    return false;
  };

  const collectSurfaceReturn = (fn) => {
    let body = fn.body;
    while (ts.isParenthesizedExpression(body)) body = body.expression;
    if (ts.isObjectLiteralExpression(body)) {
      for (const prop of body.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = propName(prop.name);
          if (name) surfaceProps.set(name, !isDisabledExpr(prop.initializer));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          surfaceProps.set(prop.name.text, true);
        }
      }
    }
  };

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createDirectApplication' &&
      node.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      foundCall = true;
      for (const prop of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = propName(prop.name);
          if (!name) continue;
          if (
            name === 'surface' &&
            (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
          ) {
            collectSurfaceReturn(prop.initializer);
          } else {
            topProps.set(name, !isDisabledExpr(prop.initializer));
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          topProps.set(prop.name.text, true);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!foundCall) parity(`${relPath}: could not find createDirectApplication({...}) call`);
  return { topProps, surfaceProps };
}

const APP_CAPABILITY_KEYS = ['hooks', 'mcpCatalog'];
const SURFACE_CAPABILITY_KEYS = ['interactive', 'sessionBrowser', 'mcp'];
const tuiWiring = extractCreateDirectAppWiring('src/app/launch-tui.tsx');
const serveWiring = extractCreateDirectAppWiring('src/app/launch-serve.ts');

const appWiringGaps = new Map();
const appWiringUniverse = new Set([...APP_CAPABILITY_KEYS, ...SURFACE_CAPABILITY_KEYS]);
for (const key of APP_CAPABILITY_KEYS) {
  if (tuiWiring.topProps.get(key) === true && serveWiring.topProps.get(key) !== true) {
    appWiringGaps.set(key, `enabled in src/app/launch-tui.tsx but disabled/null in src/app/launch-serve.ts`);
  }
}
for (const key of SURFACE_CAPABILITY_KEYS) {
  if (tuiWiring.surfaceProps.get(key) === true && serveWiring.surfaceProps.get(key) !== true) {
    appWiringGaps.set(
      key,
      `surface.${key} is enabled in src/app/launch-tui.tsx but disabled/undefined in src/app/launch-serve.ts`,
    );
  }
}
checkExceptionAlignment('appWiring', appWiringGaps, appWiringUniverse);

// ---------------------------------------------------------------------------
// 2. Protocol parity: SERVER_WIRE_COMMAND_PARITY & WEB_WIRE_EVENT_PARITY
// ---------------------------------------------------------------------------
function extractStringRecordConst(relPath, constName) {
  const sf = parse(relPath);
  const map = new Map();
  let found = false;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === constName &&
      node.initializer
    ) {
      let expr = node.initializer;
      while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
      if (ts.isObjectLiteralExpression(expr)) {
        found = true;
        for (const prop of expr.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) {
            const key = propName(prop.name);
            if (key) map.set(key, prop.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found || map.size === 0) parity(`${relPath}: could not read ${constName} object literal`);
  return map;
}

const serverCommandParity = extractStringRecordConst('src/host/server-commands.ts', 'SERVER_WIRE_COMMAND_PARITY');
const serverCommandGaps = new Map();
for (const [cmd, status] of serverCommandParity) {
  if (status !== 'supported') {
    serverCommandGaps.set(
      cmd,
      `classified as "${status}" in src/host/server-commands.ts (SERVER_WIRE_COMMAND_PARITY) without a recorded exception`,
    );
  }
}
checkExceptionAlignment('serverCommands', serverCommandGaps, new Set(serverCommandParity.keys()));

const webEventParity = extractStringRecordConst('web-client/lib/term2/session-store.ts', 'WEB_WIRE_EVENT_PARITY');
const webEventGaps = new Map();
for (const [ev, status] of webEventParity) {
  if (status !== 'presented' && status !== 'folded') {
    webEventGaps.set(
      ev,
      `classified as "${status}" in web-client/lib/term2/session-store.ts (WEB_WIRE_EVENT_PARITY) without a recorded exception`,
    );
  }
}
checkExceptionAlignment('webEvents', webEventGaps, new Set(webEventParity.keys()));

// ---------------------------------------------------------------------------
// 3. Settings parity: TUI browse-tab settings vs WEB_SETTINGS & web-client catalog
// ---------------------------------------------------------------------------
function extractSettingKeyMap() {
  const sf = parse('src/config/settings/settings-schema.ts');
  const keys = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'SETTING_KEYS' &&
      node.initializer
    ) {
      let expr = node.initializer;
      while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
      if (ts.isObjectLiteralExpression(expr)) {
        for (const prop of expr.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) {
            const name = propName(prop.name);
            if (name) keys.set(name, prop.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (keys.size < 50) parity('src/config/settings/settings-schema.ts: could not read SETTING_KEYS');
  return keys;
}

function extractTuiCategorySettings(settingKeys) {
  const sf = parse('src/app/settings-completion-config.ts');
  const result = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'CATEGORY_KEYS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isArrayLiteralExpression(prop.initializer)) {
          for (const el of prop.initializer.elements) {
            if (ts.isPropertyAccessExpression(el)) {
              const resolved = settingKeys.get(el.name.text);
              if (resolved) result.add(resolved);
            } else if (ts.isStringLiteral(el)) {
              result.add(el.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (result.size < 40) parity('src/app/settings-completion-config.ts: could not read CATEGORY_KEYS');
  return result;
}

function extractWebSettingsPolicy() {
  const sf = parse('src/config/settings/web-settings-policy.ts');
  // storedKey -> webKey
  const storedToWeb = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'WEB_SETTINGS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const webKey = propName(prop.name);
        if (!webKey) continue;
        let storedKey = webKey;
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          for (const ruleProp of prop.initializer.properties) {
            if (
              ts.isPropertyAssignment(ruleProp) &&
              propName(ruleProp.name) === 'storedAs' &&
              ts.isStringLiteral(ruleProp.initializer)
            ) {
              storedKey = ruleProp.initializer.text;
            }
          }
        }
        storedToWeb.set(storedKey, webKey);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (storedToWeb.size < 30) parity('src/config/settings/web-settings-policy.ts: could not read WEB_SETTINGS');
  return storedToWeb;
}

function extractWebCatalogKeys() {
  const catalogKeys = new Set();
  for (const relPath of [
    'web-client/components/term2/settings/settings-catalog.ts',
    'web-client/components/term2/settings/settings-catalog-parity.ts',
  ]) {
    const sf = parse(relPath);
    const visit = (node) => {
      // NEVER_SHOWN_KEYS = new Set([...])
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'NEVER_SHOWN_KEYS' &&
        node.initializer &&
        ts.isNewExpression(node.initializer)
      ) {
        const arg = node.initializer.arguments?.[0];
        if (arg && ts.isArrayLiteralExpression(arg)) {
          for (const el of arg.elements) if (ts.isStringLiteral(el)) catalogKeys.add(el.text);
        }
      }
      // SettingItem literals with `section` and `id` / `keys`
      if (ts.isObjectLiteralExpression(node)) {
        const hasSection = node.properties.some((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'section');
        if (hasSection) {
          for (const p of node.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const name = propName(p.name);
            if (name === 'id' && ts.isStringLiteral(p.initializer)) catalogKeys.add(p.initializer.text);
            if (name === 'keys' && ts.isArrayLiteralExpression(p.initializer)) {
              for (const el of p.initializer.elements) {
                if (ts.isStringLiteral(el)) catalogKeys.add(el.text);
              }
            }
          }
        }
      }
      // Helper calls: tool('tools.shell.enabled', ...) and tier('smart', ..., 'agent.smartReasoningEffort')
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = node.expression.text;
        if (fn === 'tool' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          catalogKeys.add(node.arguments[0].text);
        } else if (fn === 'tier' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          catalogKeys.add(`agent.${node.arguments[0].text}Model`);
          if (node.arguments[3] && ts.isStringLiteral(node.arguments[3])) {
            catalogKeys.add(node.arguments[3].text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return catalogKeys;
}

const settingKeys = extractSettingKeyMap();
const tuiSettings = extractTuiCategorySettings(settingKeys);
const webPolicyStoredToWeb = extractWebSettingsPolicy();
const webCatalogKeys = extractWebCatalogKeys();

const settingsGaps = new Map();
for (const storedKey of [...tuiSettings].sort()) {
  const webKey = webPolicyStoredToWeb.get(storedKey);
  const inPolicy = Boolean(webKey);
  const inCatalog = Boolean(webKey && webCatalogKeys.has(webKey));
  if (!inPolicy && !inCatalog) {
    settingsGaps.set(
      storedKey,
      `in TUI CATEGORY_KEYS (src/app/settings-completion-config.ts) but missing from WEB_SETTINGS and web-client settings catalog`,
    );
  } else if (!inPolicy) {
    settingsGaps.set(storedKey, `missing from WEB_SETTINGS in src/config/settings/web-settings-policy.ts`);
  } else if (!inCatalog) {
    settingsGaps.set(
      storedKey,
      `in WEB_SETTINGS (as "${webKey}") but missing from web-client/components/term2/settings/ catalog`,
    );
  }
}
checkExceptionAlignment('settings', settingsGaps, tuiSettings);

reportAndExit(
  failures,
  `Surface parity check passed (appWiring: ${appWiringUniverse.size}, commands: ${serverCommandParity.size}, events: ${webEventParity.size}, settings: ${tuiSettings.size}).`,
);
