import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTING_KEYS, RUNTIME_MODIFIABLE_SETTINGS, DEFAULT_SETTINGS } from './settings-schema.js';
import { resolveSettingAtPath } from './setting-schema-utils.js';
import {
  SETTING_DESCRIPTIONS,
  CATEGORY_KEYS,
  COMMON_SETTINGS,
  HIDDEN_SETTINGS,
} from '../../hooks/settings-completion-config.js';
import { MODEL_SETTING_CONFIGS } from '../../utils/ai/model-settings.js';
import { formatSettingsSummary } from '../../utils/settings-command.js';
import { buildSettingsWithSources } from './settings-sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extracts property paths declared by the SettingsWithSources interface in settings-schema.ts.
 */
function getSettingsWithSourcesPaths(): string[] {
  const schemaPath = path.join(__dirname, 'settings-schema.ts');
  const sourceCode = fs.readFileSync(schemaPath, 'utf8');
  const sourceFile = ts.createSourceFile(schemaPath, sourceCode, ts.ScriptTarget.Latest, true);

  let interfaceNode: ts.InterfaceDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'SettingsWithSources') {
      interfaceNode = node;
    }
  });

  if (!interfaceNode) {
    throw new Error('SettingsWithSources interface not found in settings-schema.ts');
  }

  const paths: string[] = [];

  function walkMembers(members: ts.NodeArray<ts.TypeElement> | ts.PropertySignature[], prefix: string) {
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        const propName = member.name.text;
        const currentPath = prefix ? `${prefix}.${propName}` : propName;

        if (member.type && ts.isTypeLiteralNode(member.type)) {
          walkMembers(member.type.members, currentPath);
        } else {
          paths.push(currentPath);
        }
      }
    }
  }

  walkMembers(interfaceNode.members, '');
  return paths;
}

/**
 * Baseline tolerance list for keys present in both CATEGORY_KEYS and HIDDEN_SETTINGS.
 * As documented in E1 and M0 of docs/plans/settings-legacy-debt.md, these represent
 * registry litter (category entries filtered out before category display).
 * This tolerance list must shrink, not grow, as legacy settings are cleaned up.
 */
export const TOLERATED_CATEGORY_HIDDEN_OVERLAP: readonly string[] = [];

describe('registry-consistency guards (M0)', () => {
  const exportedKeySet = new Set<string>(Object.values(SETTING_KEYS));

  it('every SETTING_KEYS value resolves to a schema path', () => {
    const missingInSchema: string[] = [];
    for (const key of exportedKeySet) {
      const schema = resolveSettingAtPath(key);
      if (!schema) {
        missingInSchema.push(key);
      }
    }

    expect(missingInSchema).toEqual([]);
  });

  it('every schema path that SettingsWithSources declares has a corresponding SETTING_KEYS entry or parent', () => {
    const swsPaths = getSettingsWithSourcesPaths();
    expect(swsPaths.length).toBeGreaterThan(0);

    const missingInSettingKeys: string[] = [];
    for (const p of swsPaths) {
      const exactMatch = exportedKeySet.has(p);
      const prefixMatch = [...exportedKeySet].some((k) => k.startsWith(`${p}.`));
      if (!exactMatch && !prefixMatch) {
        missingInSettingKeys.push(p);
      }
    }

    expect(missingInSettingKeys).toEqual([]);
  });

  it('every key in SETTING_DESCRIPTIONS is a SETTING_KEYS member', () => {
    const invalidKeys = Object.keys(SETTING_DESCRIPTIONS).filter((k) => !exportedKeySet.has(k));
    expect(invalidKeys).toEqual([]);
  });

  it('every key in CATEGORY_KEYS is a SETTING_KEYS member', () => {
    const invalidKeys: string[] = [];
    for (const [category, set] of Object.entries(CATEGORY_KEYS)) {
      for (const key of set) {
        if (!exportedKeySet.has(key)) {
          invalidKeys.push(`${category}:${key}`);
        }
      }
    }
    expect(invalidKeys).toEqual([]);
  });

  it('every key in COMMON_SETTINGS is a SETTING_KEYS member', () => {
    const invalidKeys = COMMON_SETTINGS.filter((k) => !exportedKeySet.has(k));
    expect(invalidKeys).toEqual([]);
  });

  it('every key in HIDDEN_SETTINGS is a SETTING_KEYS member', () => {
    const invalidKeys = [...HIDDEN_SETTINGS].filter((k) => !exportedKeySet.has(k));
    expect(invalidKeys).toEqual([]);
  });

  it('every key in RUNTIME_MODIFIABLE_SETTINGS is a SETTING_KEYS member', () => {
    const invalidKeys = [...RUNTIME_MODIFIABLE_SETTINGS].filter((k) => !exportedKeySet.has(k));
    expect(invalidKeys).toEqual([]);
  });

  it('no key appears in both CATEGORY_KEYS and HIDDEN_SETTINGS outside the tolerance list', () => {
    const categoryKeys = new Set<string>();
    for (const set of Object.values(CATEGORY_KEYS)) {
      for (const key of set) {
        categoryKeys.add(key);
      }
    }

    const overlap = [...categoryKeys].filter((k) => HIDDEN_SETTINGS.has(k)).sort();
    expect(overlap).toEqual([...TOLERATED_CATEGORY_HIDDEN_OVERLAP].sort());
    // The tolerance list has shrunk to zero
    expect(overlap.length).toBe(0);
  });

  it('every MODEL_SETTING_CONFIGS model/provider key is a SETTING_KEYS member', () => {
    const invalidKeys: string[] = [];
    for (const config of MODEL_SETTING_CONFIGS) {
      if (!exportedKeySet.has(config.modelKey)) {
        invalidKeys.push(`modelKey:${config.modelKey}`);
      }
      if (!exportedKeySet.has(config.providerKey)) {
        invalidKeys.push(`providerKey:${config.providerKey}`);
      }
      if (config.fallbackProviderKey && !exportedKeySet.has(config.fallbackProviderKey)) {
        invalidKeys.push(`fallbackProviderKey:${config.fallbackProviderKey}`);
      }
    }
    expect(invalidKeys).toEqual([]);
  });

  it('every formatSettingsSummary entry key is a SETTING_KEYS member', () => {
    const withSources = buildSettingsWithSources(DEFAULT_SETTINGS, () => 'default');
    const summary = formatSettingsSummary(withSources);
    const summaryLines = summary.split('\n').filter((l) => l.trim().length > 0);
    expect(summaryLines.length).toBeGreaterThan(0);

    const summaryKeys = summaryLines.map((line) => line.split(':')[0].trim());
    const invalidKeys = summaryKeys.filter((k) => !exportedKeySet.has(k));
    expect(invalidKeys).toEqual([]);
  });
});
