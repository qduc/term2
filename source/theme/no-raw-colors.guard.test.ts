import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Guards the theme contract: a component names a *meaning* (`theme.danger`) and
 * the user's `ui.theme` decides the colour. Three things quietly break that, and
 * each one has already shipped a bug or a drifted palette:
 *
 *  - a hex literal in a component: one-off colours that no theme can change (the
 *    palette once drifted to 29 of them), and that nobody checked for contrast;
 *  - a named terminal colour (`'green'`, `'gray'`): resolved against the user's own
 *    terminal palette, so it differs per machine and can land unreadable;
 *  - a removed `COLOR_*` / `TOOL_STATUS_COLOR` / `MODE_BADGE_*` constant: a static
 *    colour that bypasses the active theme entirely.
 *
 * Palettes themselves live in `source/theme/`, which is the one place hex
 * literals belong.
 */

const sourceRoot = path.resolve(import.meta.dirname, '..');
const themeDirectory = path.resolve(import.meta.dirname);

const NAMED_COLORS =
  'black|red|green|yellow|blue|magenta|cyan|white|gray|grey|blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|cyanBright|whiteBright';

/**
 * Where named colours are checked. `color: 'white'` is also an ordinary data key
 * (the profile registry carries presentation metadata that no component renders),
 * so that rule applies only to code that draws the terminal UI.
 */
const UI_PATHS = ['components/', 'hooks/', 'skins/', 'app.tsx', 'cli.tsx'];
export const isUiSource = (relativePath: string): boolean => UI_PATHS.some((p) => relativePath.startsWith(p));

const RULES: ReadonlyArray<{ name: string; pattern: RegExp; uiOnly?: boolean }> = [
  { name: 'hex colour literal', pattern: /['"`]#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?['"`]/ },
  {
    name: 'named terminal colour',
    uiOnly: true,
    pattern: new RegExp(`\\b(?:color|backgroundColor|borderColor)(?:=|:\\s*)\\{?\\s*['"](?:${NAMED_COLORS})['"]`),
  },
  {
    name: 'removed static colour constant',
    pattern: /\b(?:COLOR_[A-Z_]+|TOOL_STATUS_COLOR|MODE_BADGE_(?:BACKGROUND|FOREGROUND))\b/,
  },
];

export function findThemeViolations(source: string, options: { ui?: boolean } = {}): string[] {
  const { ui = true } = options;
  const violations: string[] = [];
  source.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.uiOnly && !ui) continue;
      if (rule.pattern.test(line)) {
        violations.push(`line ${index + 1}: ${rule.name}: ${line.trim()}`);
      }
    }
  });
  return violations;
}

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === themeDirectory) continue;
      files.push(...(await productionSources(fullPath)));
    } else if (
      entry.isFile() &&
      (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) &&
      !/\.test\.tsx?$/.test(fullPath)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('findThemeViolations', () => {
  it('checks named colours only in UI code, where they would be rendered', () => {
    const line = "presentation: { label: 'STD', color: 'white' },";
    expect(findThemeViolations(line, { ui: true })).toHaveLength(1);
    expect(findThemeViolations(line, { ui: false })).toEqual([]);
    expect(isUiSource('components/message/ChatMessage.tsx')).toBe(true);
    expect(isUiSource('hooks/use-setting.ts')).toBe(true);
    expect(isUiSource('skins/rail/index.ts')).toBe(true);
    expect(isUiSource('services/profiles/registry.ts')).toBe(false);
  });

  it('flags hex literals and removed constants everywhere, UI or not', () => {
    expect(findThemeViolations("const x = '#22d3ee';", { ui: false })).toHaveLength(1);
    expect(findThemeViolations('const c = COLOR_ACCENT;', { ui: false })).toHaveLength(1);
  });

  it.each([
    ["const x = '#22d3ee';", 'hex colour literal'],
    ['const x = "#A78BFA";', 'hex colour literal'],
    ['<Text color="green">ok</Text>', 'named terminal colour'],
    ["<Text backgroundColor='red'>x</Text>", 'named terminal colour'],
    ["const style = { color: 'gray' };", 'named terminal colour'],
    ['<Text color={COLOR_ACCENT}>x</Text>', 'removed static colour constant'],
    ['const c = TOOL_STATUS_COLOR.failed;', 'removed static colour constant'],
  ])('flags %s', (line, rule) => {
    const found = findThemeViolations(line);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(rule);
  });

  it.each([
    '<Text color={theme.danger}>x</Text>',
    "const tone: ColorRole = 'danger';",
    "const issue = 'see #123456 for details';",
    "const anchor = '#section';",
    '<Text color={theme[tone]}>x</Text>',
  ])('allows %s', (line) => {
    expect(findThemeViolations(line)).toEqual([]);
  });
});

describe('production source', () => {
  it('takes every colour from the active theme', async () => {
    const files = await productionSources(sourceRoot);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(sourceRoot, file);
      const violations = findThemeViolations(await readFile(file, 'utf8'), { ui: isUiSource(relative) });
      for (const violation of violations) {
        offenders.push(`${relative} ${violation}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
