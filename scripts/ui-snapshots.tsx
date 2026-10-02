/**
 * Renders the shared skin scenes (`source/skins/testing/scenes.tsx`) for any mix of
 * skin, theme and terminal width, and writes them as ANSI, a self-contained HTML
 * page, and — when Playwright is available — a PNG. This is how to *see* a skin.
 *
 *   NODE_ENV=test FORCE_COLOR=3 COLORTERM=truecolor TERM=xterm-256color \
 *     node_modules/.bin/tsx scripts/ui-snapshots.tsx \
 *       --skin rail --theme dark,light --width 60,100 --scene all --out /tmp/shots --png
 *
 * Flags (comma-separated lists, or `all`):
 *   --skin    classic|rail|cards|ledger|zen          (default: all)
 *   --theme   dark|light|high-contrast|mono          (default: dark)
 *   --width   terminal columns                       (default: 100)
 *   --scene   scene ids from scenes.tsx              (default: all)
 *   --bg      dark|light  terminal background to draw on; defaults to what the theme is for
 *   --out     output directory                       (required)
 *   --png     also write PNGs (needs playwright-core; see PLAYWRIGHT_CORE / PLAYWRIGHT_CHROMIUM)
 *
 * NODE_ENV=test is required (React's production build has no `act`); FORCE_COLOR and
 * COLORTERM make the output truecolour so palettes are rendered faithfully.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SKIN_NAMES, type SkinName } from './../source/skins/names.js';
import { SCENES, renderScene } from './../source/skins/testing/scenes.js';
import { THEME_NAMES, type ThemeName } from './../source/theme/palettes.js';
import { ansiToHtmlPage } from './ui-snapshots/ansi-to-html.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function list<T extends string>(raw: string | undefined, all: readonly T[], fallback: readonly T[]): T[] {
  if (raw === undefined) return [...fallback];
  if (raw === 'all') return [...all];
  const wanted = raw.split(',').map((item) => item.trim());
  const unknown = wanted.filter((item) => !all.includes(item as T));
  if (unknown.length > 0) {
    console.error(`Unknown value(s) ${unknown.join(', ')}; expected one of: ${all.join(', ')}`);
    process.exit(2);
  }
  return wanted as T[];
}

const out = option('out');
if (!out) {
  console.error('Missing --out <directory>. See the header of scripts/ui-snapshots.tsx.');
  process.exit(2);
}

const skins = list<SkinName>(option('skin'), SKIN_NAMES, SKIN_NAMES);
const themes = list<ThemeName>(option('theme'), THEME_NAMES, ['dark']);
const widths = (option('width') ?? '100').split(',').map(Number);
const sceneIds = list(
  option('scene'),
  SCENES.map((scene) => scene.id),
  SCENES.map((scene) => scene.id),
);
const wantPng = process.argv.includes('--png');
const explicitBackground = option('bg') as 'dark' | 'light' | undefined;

const backgroundFor = (theme: ThemeName): 'dark' | 'light' =>
  explicitBackground ?? (theme === 'light' ? 'light' : 'dark');

fs.mkdirSync(out, { recursive: true });

interface Rendered {
  base: string;
  html: string;
}
const rendered: Rendered[] = [];

for (const skin of skins) {
  for (const theme of themes) {
    for (const columns of widths) {
      for (const sceneId of sceneIds) {
        const scene = SCENES.find((candidate) => candidate.id === sceneId)!;
        const base = `${skin}.${theme}.${sceneId}@${columns}`;
        try {
          const ansi = renderScene(scene, { skin, theme, columns });
          fs.writeFileSync(path.join(out, `${base}.ansi`), ansi);
          const html = ansiToHtmlPage(ansi, columns, backgroundFor(theme));
          fs.writeFileSync(path.join(out, `${base}.html`), html);
          rendered.push({ base, html });
        } catch (error) {
          console.error(`FAILED ${base}: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      }
    }
  }
}
console.log(`wrote ${rendered.length} scene(s) to ${out}`);

if (wantPng && rendered.length > 0) {
  const require = createRequire(import.meta.url);
  let chromium: { launch: (options: object) => Promise<any> } | undefined;
  try {
    chromium = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core').chromium;
  } catch {
    console.error(
      'PNG output needs playwright-core. Set PLAYWRIGHT_CORE to its install path (and PLAYWRIGHT_CHROMIUM to a ' +
        'Chromium binary; default /opt/pw-browsers/chromium). HTML files were written and open in any browser.',
    );
  }
  if (chromium) {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({ deviceScaleFactor: 1.5 });
    for (const { base, html } of rendered) {
      await page.setContent(html);
      await (await page.$('pre')).screenshot({ path: path.join(out, `${base}.png`) });
    }
    await browser.close();
    console.log(`wrote ${rendered.length} PNG(s)`);
  }
}

// Ink and a few containers leave timers behind; the run is done.
process.exit(process.exitCode ?? 0);
