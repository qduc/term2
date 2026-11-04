// The scripted screenshot walk: the same keys, at a person's pace, for both CLIs. Each step ends with a
// screenshot of the xterm.js screen (masks painted over) and the screen text.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './terminal.mjs';
import { typeText, PRELUDE, COMPOSER_READY, AT_HOME } from './session.mjs';

/**
 * The only things masked before pixels are compared (issue #140): version, ids, paths, ports, durations
 * (including wall-clock times and relative ages, which move between runs) and spinner frames.
 */
export const MASKS = [
  { name: 'version', re: /\bv\d+\.\d+\.\d+[-+\w.]*/ },
  { name: 'id', re: /\bconv_[0-9a-f-]{36}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bnon-interactive-[0-9a-f-]+/ },
  { name: 'path', re: /(?:~|\/(?:tmp|home|root|var|Users|private|opt))(?:\/[\w.@+-]+)+\/?/ },
  { name: 'port', re: /\b(?:127\.0\.0\.1|localhost):\d+\b/ },
  {
    name: 'duration',
    re: /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b|\b\d+ (?:seconds?|minutes?|hours?|days?|months?) ago\b|\b\d+(?:\.\d+)? ?(?:tok\/s|t\/s)|\b\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?/,
  },
  { name: 'spinner', re: /[⠀-⣿]/ },
];

const KEYS = { enter: '\r', escape: '\x1b', down: '\x1b[B', ctrlC: '\x03', ctrlO: '\x0f', shiftTab: '\x1b[Z' };
const READY = `fn:${COMPOSER_READY}`;
const NOT_READY_OR_MENU = `fn:return !(() => { ${AT_HOME} })();`;

/**
 * Each step: what to do, what to wait for (soft: a timeout is recorded, the screenshot is still taken), and a
 * name. `resize` steps change both the pty and xterm.js.
 */
export function walkSteps({ resizeTo }) {
  return [
    { name: '01-startup', do: async () => {}, until: READY },
    { name: '02-composer-typed', do: (t) => typeText(t, 'show markdown please'), until: 'show markdown please' },
    { name: '03-turn-markdown', do: (t) => t.write(KEYS.enter), until: /That is all|That is \*\*all\*\*/, then: READY },
    { name: '04-turn-tool-call', do: (t) => send(t, 'list the files please'), until: /Done\. The command finished/, then: READY },
    { name: '05-approval-prompt', do: (t) => send(t, 'create a file please'), until: /Allow once/ },
    { name: '06-approval-approved', do: (t) => t.write(KEYS.enter), until: /touch created-by-walk|Shell command/, then: READY },
    { name: '07-slash-menu', do: (t) => typeText(t, '/'), until: /\/model|\/resume|Commands/ },
    { name: '08-slash-menu-closed', do: (t) => escapeHome(t), until: READY },
    { name: '09-path-menu', do: (t) => typeText(t, '@'), until: /README\.md|notes\.txt|src/ },
    { name: '10-path-menu-closed', do: (t) => escapeHome(t), until: READY },
    { name: '11-menu-model', do: (t) => send(t, '/model'), until: NOT_READY_OR_MENU },
    { name: '12-menu-model-arrow', do: (t) => t.write(KEYS.down), until: NOT_READY_OR_MENU },
    { name: '13-menu-model-closed', do: (t) => escapeHome(t), until: READY },
    { name: '14-menu-settings', do: (t) => send(t, '/settings'), until: NOT_READY_OR_MENU },
    { name: '15-menu-settings-arrow', do: (t) => t.write(KEYS.down), until: NOT_READY_OR_MENU },
    { name: '16-menu-settings-closed', do: (t) => escapeHome(t), until: READY },
    { name: '17-ctrl-o', do: (t) => t.write(KEYS.ctrlO), until: null },
    { name: '18-ctrl-o-closed', do: (t) => escapeHome(t, KEYS.ctrlO), until: READY },
    { name: '19-shift-tab', do: (t) => t.write(KEYS.shiftTab), until: null },
    { name: '20-shift-tab-restored', do: (t) => restoreMode(t), until: READY },
    { name: '21-help', do: (t) => send(t, '/help'), until: null },
    { name: '22-help-closed', do: (t) => escapeHome(t), until: READY },
    { name: '23-resume-list', do: (t) => send(t, '/resume'), until: /\d+ msgs?\b/, timeoutMs: 15 * 60_000 },
    { name: '24-resume-preview', do: (t) => t.write(KEYS.down), until: /Preview|Initial Prompt|ID: /, timeoutMs: 60_000 },
    { name: '25-resume-closed', do: (t) => escapeHome(t), until: READY },
    { name: '26-resize', resize: resizeTo, until: READY },
    { name: '27-resize-typed', do: (t) => typeText(t, 'typed after resize'), until: 'typed after resize' },
    { name: '28-resize-back', resize: 'original', until: READY },
    { name: '29-exit-confirm', do: (t) => clearThen(t, KEYS.ctrlC), until: /Ctrl\+C again/ },
    { name: '30-exited', do: (t) => t.write(KEYS.ctrlC), until: null, exit: true },
  ];
}

async function send(t, text) {
  await typeText(t, text);
  await sleep(250);
  t.write(KEYS.enter);
}

async function clearThen(t, key) {
  for (let i = 0; i < 24; i++) {
    t.write('\x7f');
    await sleep(8);
  }
  await sleep(200);
  t.write(key);
}

/** Leave whatever is open (or undo a toggle key) until the empty composer is back. */
async function escapeHome(t, undoKey = null) {
  const home = async () => t.page.evaluate(new Function(`const lines = window.screenLines(); ${AT_HOME}`));
  if (undoKey && (await home())) {
    // The key toggled something without opening a view (term2-next's tool output): press it again.
    t.write(undoKey);
    await sleep(400);
    return;
  }
  for (let i = 0; i < 5 && !(await home()); i++) {
    t.write(KEYS.escape);
    await t.waitFor(`fn:${AT_HOME}`, 2_000).catch(() => {});
  }
}

/** Shift+Tab switched mode (legacy) or opened a confirmation (term2-next): get back to the starting state. */
async function restoreMode(t) {
  const text = (await t.screen()).join('\n');
  if (/Clear session and switch/.test(text)) {
    t.write(KEYS.escape);
    return;
  }
  t.write(KEYS.shiftTab);
}

export async function runWalk(session, { outDir, label, originalSize, resizeTo, log = () => {} }) {
  const { term } = session;
  const steps = walkSteps({ resizeTo });
  const shots = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const step of steps) {
    const note = [];
    const startedAt = Date.now();
    if (step.resize) {
      const [cols, rows] = step.resize === 'original' ? originalSize : step.resize;
      await term.resize(cols, rows);
    } else {
      await step.do(term);
    }
    if (step.until) {
      await term.waitFor(step.until, step.timeoutMs ?? 30_000).catch(() => note.push(`wait timed out: ${String(step.until).slice(0, 80)}`));
    }
    if (step.then) await term.waitFor(step.then, 30_000).catch(() => note.push('composer did not come back'));
    if (step.exit) await Promise.race([term.exit, sleep(5_000)]);
    await sleep(250);
    await term.quiet(400, 8_000);
    const file = path.join(outDir, `${label}-${step.name}.png`);
    const masks = await term.screenshot(file, MASKS.map((m) => m.re));
    shots.push({
      step: step.name,
      file,
      text: (await term.screen()).join('\n'),
      masks: masks.length,
      ms: Date.now() - startedAt,
      note,
      size: [term.cols, term.rows],
    });
    log(`  ${step.name}${note.length ? ` (${note.join('; ')})` : ''}`);
  }
  return shots;
}
