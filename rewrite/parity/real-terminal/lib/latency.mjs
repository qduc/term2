// Key-to-paint latency per keystroke class, idle and while a reply streams.
//
// Every sample: setup (unmeasured) -> one key injected from the page -> stop at the first xterm.js render whose
// screen satisfies the class predicate. CPU is the CLI process tree's utime+stime and bytes are pty output,
// both over [injection, paint + 100 ms]. While streaming, both include the stream's own rendering.
import { sleep, treeCpuMs } from './terminal.mjs';
import { PRELUDE, AT_HOME, typeText, STREAM_ROW } from './session.mjs';

const KEYS = {
  enter: '\r',
  backspace: '\x7f',
  escape: '\x1b',
  down: '\x1b[B',
  up: '\x1b[A',
  pageDown: '\x1b[6~',
  pageUp: '\x1b[5~',
  ctrlO: '\x0f',
  shiftTab: '\x1b[Z',
};

export const CLASSES = [
  'type char',
  'backspace',
  'enter (composer)',
  'arrow (model menu)',
  'arrow (resume menu)',
  'ctrl+o',
  'shift+tab',
  'open /model',
  'open /settings',
  'scroll (resume page down/up)',
];

const fn = (body) => `fn:${PRELUDE}${body}`;
const composerHas = (text) => fn(`return composer.includes(${JSON.stringify(text)});`);
const composerLacks = (text) => fn(`return !composer.includes(${JSON.stringify(text)});`);
const backspaced = (kept, removed) =>
  fn(`return composer.includes(${JSON.stringify(kept)}) && !composer.includes(${JSON.stringify(kept + removed)});`);
const tailChangedFrom = (before) => fn(`return tail() !== ${JSON.stringify(before)};`);
// For measured keys the baseline tail is taken on the page at the instant of injection.
const TAIL_CHANGED = fn('return tail() !== base;');
const TAIL_NOW = fn('return tail();');

async function tailOf(term) {
  return term.page.evaluate(new Function(`const lines = window.screenLines(); ${PRELUDE} return tail();`));
}

/** How long any expected paint may take. Longer is a failure; waiting longer would only measure how bad. */
export const PAINT_TIMEOUT_MS = 5_000;

/**
 * `restart` (optional) replaces a CLI that stopped answering keys with a fresh one on the same home, so a paint
 * that arrives late cannot land in a later sample. It returns the new session.
 */
export async function runLatency(session, { phase, samples = {}, log = () => {}, misses = [], restart = null }) {
  let current = session;
  let term = session.term;
  const results = Object.fromEntries(CLASSES.map((name) => [name, []]));
  const n = (name, fallback) => samples[name] ?? fallback;
  const streaming = phase === 'streaming';

  const settle = async () => {
    if (streaming) await sleep(120);
    else await term.quiet(120, 4_000);
  };

  /** Keep a reply streaming during the streaming phase (re-prompt when the previous stream ended). */
  let openMenu = null; // the slash menu openSlash opened, while it is open
  const ensureStream = async () => {
    if (!streaming) return;
    if (current.provider.activeStreams() > 0) return;
    // Never type the prompt into an open menu (its filter would take it): back to the empty composer first.
    await ensureHome();
    await typeText(term, 'stream a long reply please');
    await sleep(80);
    term.write(KEYS.enter);
    const started = Date.now();
    while (current.provider.activeStreams() === 0 && Date.now() - started < PAINT_TIMEOUT_MS) await sleep(20);
    await term.waitFor(STREAM_ROW, PAINT_TIMEOUT_MS);
    await sleep(300);
  };

  const atHome = () => term.page.evaluate(new Function(`const lines = window.screenLines(); ${AT_HOME}`));
  /** Back to the empty composer: Escape out of menus, clear typed text. Never sends Escape while home. */
  const ensureHome = async () => {
    for (let attempt = 0; attempt < 4 && !(await atHome()); attempt++) {
      const typed = await term.page.evaluate(new Function(`const lines = window.screenLines(); ${PRELUDE} return /^\\s*❯\\s*\\S/.test(composer) ? composer.replace(/^\\s*❯\\s*/, '').length : 0;`));
      if (typed > 0) await clearComposer(typed + 2);
      else {
        term.write(KEYS.escape);
        await term.waitFor(`fn:${AT_HOME}`, 2_000).catch(() => {});
        await settle();
      }
    }
    // Still not home: the CLI stopped answering (a frozen UI). Replace it so a late paint cannot land in a
    // later sample.
    if (restart && !(await atHome())) {
      log('  CLI not answering keys, restarting it');
      openMenu = null;
      current = await restart(current);
      term = current.term;
    }
  };
  const recover = async () => {
    openMenu = null;
    await ensureHome();
  };

  const measure = async (name, key, predicate, timeoutMs = PAINT_TIMEOUT_MS, { typed = false } = {}) => {
    if (streaming && openMenu && current.provider.activeStreams() === 0) {
      // The reply ended while a menu is open: close it, start another reply, reopen the same menu.
      const command = openMenu;
      await closeMenu();
      await ensureStream();
      await openSlash(command);
      if (command === '/resume') await term.waitFor(RESUME_LIST, PAINT_TIMEOUT_MS).catch(() => {});
      await settle();
    }
    // With a command already typed, restarting the reply would clear it; the caller started one just before.
    if (!typed) await ensureStream();
    const cpu0 = treeCpuMs(term.pid);
    const bytes0 = term.bytes;
    const base = predicate === TAIL_CHANGED ? TAIL_NOW : null;
    const result = await term.measureKey(key, predicate, timeoutMs, base);
    await sleep(100);
    const sample = {
      ok: result.ok,
      pre: result.pre ?? false,
      ms: result.ms,
      parseMs: result.parseMs,
      cpuMs: treeCpuMs(term.pid) - cpu0,
      bytes: term.bytes - bytes0,
      streaming: streaming && current.provider.activeStreams() > 0,
    };
    results[name].push(sample);
    if (!result.ok) {
      log(`  ${name}: no matching paint within ${timeoutMs} ms`);
      misses.push({ phase, name, index: results[name].length - 1, screen: await term.screenText() });
    }
    return sample;
  };

  const clearComposer = async (count) => {
    for (let i = 0; i < count; i++) {
      term.write(KEYS.backspace);
      await sleep(8);
    }
    await settle();
  };

  /** Open a slash menu by typing it and pressing Enter (unmeasured). */
  const openSlash = async (command) => {
    openMenu = command;
    await typeText(term, command);
    await term.waitFor(composerHas(command), 5_000).catch(() => {});
    const before = await tailOf(term);
    term.write(KEYS.enter);
    await term.waitFor(tailChangedFrom(before), 8_000).catch(() => {});
    await settle();
    await sleep(300);
  };

  const closeMenu = async () => {
    openMenu = null;
    term.write(KEYS.escape);
    await sleep(200);
    await settle();
    await ensureHome();
  };

  // --- typing and backspace: cycles of a unique prefix, then measured characters, then measured backspaces.
  const letters = 'abcdefghijkl';
  const cycles = Math.ceil(Math.max(n('type char', 48), n('backspace', 48)) / letters.length);
  for (let cycle = 0; cycle < cycles; cycle++) {
    await ensureStream();
    await ensureHome();
    const prefix = `q${cycle}z`;
    await typeText(term, prefix, 15);
    await term.waitFor(composerHas(prefix), 5_000).catch(() => log(`  typing prefix ${prefix} did not appear`));
    await settle();
    let typed = prefix;
    for (const ch of letters) {
      typed += ch;
      await measure('type char', ch, composerHas(typed), PAINT_TIMEOUT_MS, { typed: true });
      await settle();
    }
    for (let i = letters.length - 1; i >= 0; i--) {
      const kept = typed.slice(0, -1);
      await measure('backspace', KEYS.backspace, backspaced(kept, typed.at(-1)), PAINT_TIMEOUT_MS, { typed: true });
      typed = kept;
      await settle();
    }
    await clearComposer(prefix.length);
  }
  log(`  typing done`);

  // --- Enter on the composer: a short prompt each time. Idle waits for the reply to finish.
  for (let i = 0; i < n('enter (composer)', 10); i++) {
    await ensureStream();
    await ensureHome();
    const text = `ping ${phase} ${i}`;
    await typeText(term, text);
    await term.waitFor(composerHas(text), 5_000).catch(() => log(`  prompt ${text} did not appear`));
    await settle();
    await measure('enter (composer)', KEYS.enter, composerLacks(text), PAINT_TIMEOUT_MS, { typed: true });
    if (streaming) {
      await settle();
    } else {
      await term.waitFor(`Sure. This is a short answer to: ${text}`, 30_000).catch(() => {});
      await term.quiet(300, 10_000);
    }
  }
  log(`  enter done`);

  // --- Arrow keys in the model menu.
  await ensureStream();
  await openSlash('/model');
  for (let i = 0; i < n('arrow (model menu)', 20); i++) {
    await measure('arrow (model menu)', i % 2 === 0 ? KEYS.down : KEYS.up, TAIL_CHANGED);
    await settle();
  }
  await closeMenu();
  log(`  model menu arrows done`);

  // --- Arrow keys and paging in the resume menu (the list a large store fills). Wait for the list first: the
  // first open's load time is reported by measureStoreTimings, not here.
  await ensureStream();
  await openSlash('/resume');
  // A list that has not painted within the timeout fails every resume-list key (legacy does not open it while a
  // reply streams): they are recorded as misses without being sent, and the CLI is recovered.
  const listed = await term.waitFor(RESUME_LIST, PAINT_TIMEOUT_MS).then(() => true, () => false);
  if (listed) {
    await settle();
    for (let i = 0; i < n('arrow (resume menu)', 20); i++) {
      await measure('arrow (resume menu)', i % 4 < 2 ? KEYS.down : KEYS.up, TAIL_CHANGED);
      await settle();
    }
    for (let i = 0; i < n('scroll (resume page down/up)', 10); i++) {
      await measure('scroll (resume page down/up)', i % 2 === 0 ? KEYS.pageDown : KEYS.pageUp, TAIL_CHANGED);
      await settle();
    }
    await closeMenu();
  } else {
    log(`  resume list did not render within ${PAINT_TIMEOUT_MS} ms`);
    const screen = await term.screenText();
    for (const [name, count] of [['arrow (resume menu)', n('arrow (resume menu)', 20)], ['scroll (resume page down/up)', n('scroll (resume page down/up)', 10)]]) {
      for (let i = 0; i < count; i++) results[name].push({ ok: false, pre: false, ms: null, unsent: true, streaming });
      misses.push({ phase, name, index: 0, screen: `(list not painted within ${PAINT_TIMEOUT_MS} ms; ${count} keys not sent)\n${screen}` });
    }
    await recover();
  }
  log(`  resume menu done`);

  // --- Ctrl+O and Shift+Tab: whatever each CLI paints in response; restored after each sample.
  for (let i = 0; i < n('ctrl+o', 10); i++) {
    await ensureHome();
    const sample = await measure('ctrl+o', KEYS.ctrlO, TAIL_CHANGED);
    await settle();
    // Legacy opens the model menu; term2-next toggles tool output. Undo whichever happened.
    if (!(await atHome())) await ensureHome();
    else if (sample.ok) {
      term.write(KEYS.ctrlO);
      await settle();
    }
  }
  for (let i = 0; i < n('shift+tab', 10); i++) {
    await ensureHome();
    await measure('shift+tab', KEYS.shiftTab, TAIL_CHANGED);
    await settle();
    // term2-next asks to clear the session first (declined by Escape); legacy switched mode and the next press
    // switches back.
    await ensureHome();
  }
  log(`  ctrl+o / shift+tab done`);

  // --- Opening /model and /settings: Enter on the typed command.
  for (const [name, command] of [
    ['open /model', '/model'],
    ['open /settings', '/settings'],
  ]) {
    for (let i = 0; i < n(name, 8); i++) {
      await ensureStream();
      await ensureHome();
      await typeText(term, command);
      await term.waitFor(composerHas(command), 5_000).catch(() => {});
      await sleep(200);
      await settle();
      await measure(name, KEYS.enter, TAIL_CHANGED, PAINT_TIMEOUT_MS, { typed: true });
      await settle();
      await sleep(200);
      await closeMenu();
    }
  }
  log(`  menus done`);
  return results;
}

/**
 * The resume list has painted with entries. Legacy rows end in "N msgs"; term2-next shows a Preview pane beside
 * the selected row, and at 80 columns it truncates rows before their message count.
 */
export const RESUME_LIST = /\d+ msgs?\b|❯ [^\n]+\bPreview\b/;

/**
 * Time from Enter on `/resume` to the first paint of the session list, twice (the first open may build an index),
 * plus whether keys were answered while it loaded. Run right after startup, before anything else.
 */
export async function measureStoreTimings(session, { timeoutMs = PAINT_TIMEOUT_MS } = {}) {
  const { term } = session;
  const out = {};
  for (const label of ['firstResumeMs', 'secondResumeMs']) {
    await typeText(term, '/resume');
    await sleep(300);
    await term.quiet(200, 3_000);
    // The list must appear after the key: the screen differs from the one at injection and shows session rows.
    const listed = `fn:return lines.join('\\n') !== base && /Resume Conversation/.test(lines.join('\\n')) && ${RESUME_LIST}.test(lines.join('\\n'));`;
    const result = await term.measureKey('\r', listed, timeoutMs, 'fn:return lines.join("\\n");');
    out[label] = result.ok ? result.ms : null;
    if (!result.ok) {
      // Over the timeout is a failure. Leave the CLI to the caller to replace (`needsRestart`): it may still be
      // loading, and a list that paints later would land in the next measurement.
      out.failed = `${label === 'firstResumeMs' ? 'first' : 'second'} /resume: no list within ${timeoutMs} ms`;
      out.needsRestart = true;
      break;
    }
    await sleep(300);
    // Escape until home is verified: never type the next command into a list that is still open (Enter there
    // resumes a session).
    let home = false;
    for (let attempt = 0; attempt < 5 && !home; attempt++) {
      term.write('\x1b');
      home = await term.waitFor(`fn:${AT_HOME}`, 3_000).then(() => true, () => false);
      if (!home) out.escapeRetries = (out.escapeRetries ?? 0) + 1;
    }
    if (!home) throw new Error('resume list did not close after 5 Escapes');
    await term.quiet(300, 5_000);
  }
  // After a failed first open the second is not a cached reopen; it is not measured.
  out.secondResumeMs ??= null;
  return out;
}

/** p50/p95/max of the successful samples, plus mean CPU and bytes per key. */
export function summarize(samples) {
  const ok = samples.filter((s) => s.ok && !s.pre);
  const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] : null);
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  return {
    n: samples.length,
    ok: ok.length,
    missed: samples.filter((s) => !s.ok).length,
    pre: samples.filter((s) => s.pre).length,
    p50: q(0.5),
    p95: q(0.95),
    max: ms.length ? ms.at(-1) : null,
    parseP50: (() => {
      const p = ok.map((s) => s.parseMs).sort((a, b) => a - b);
      return p.length ? p[Math.ceil(0.5 * p.length) - 1] : null;
    })(),
    cpuMsPerKey: mean(samples.map((s) => s.cpuMs)),
    bytesPerKey: mean(samples.map((s) => s.bytes)),
  };
}

/**
 * Gate for one class: next within 1.2x or 5 ms of legacy at p50 and p95, no key over 200 ms, and no more
 * keys without the expected paint than legacy had. A class where neither CLI painted anything is n/a.
 */
export function gate(legacy, next) {
  if (legacy.ok === 0 && next.ok === 0) return { pass: true, na: true, reasons: ['neither CLI painted a change'] };
  const within = (l, n) => l !== null && n !== null && (n <= l * 1.2 || n - l <= 5);
  const reasons = [];
  if (next.ok === 0) reasons.push('no matching paint (legacy painted)');
  if (next.missed > legacy.missed) reasons.push(`${next.missed} key(s) never painted the change (legacy ${legacy.missed})`);
  if (next.ok > 0 && legacy.ok > 0) {
    if (!within(legacy.p50, next.p50)) reasons.push('p50 over 1.2x / +5 ms');
    if (!within(legacy.p95, next.p95)) reasons.push('p95 over 1.2x / +5 ms');
  }
  if (next.max !== null && next.max > 200) reasons.push(`input stall ${next.max.toFixed(0)} ms > 200 ms`);
  return { pass: reasons.length === 0, reasons };
}
