// Pixel diff (in Chromium, on canvases) and the HTML report.
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES } from './latency.mjs';

/** Compare two PNGs pixel by pixel. Writes a diff PNG (red = differs) and returns the count. */
export async function diffImages(stage, a, b, diffFile) {
  const page = await stage.browser.newPage();
  try {
    const toUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    const result = await page.evaluate(
      async ({ a, b }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const w = Math.max(ia.width, ib.width);
        const h = Math.max(ia.height, ib.height);
        const read = (img) => {
          const c = new OffscreenCanvas(w, h);
          const x = c.getContext('2d');
          x.fillStyle = '#ff00ff';
          x.fillRect(0, 0, w, h);
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, w, h).data;
        };
        const pa = read(ia);
        const pb = read(ib);
        const out = new OffscreenCanvas(w, h);
        const ox = out.getContext('2d');
        const diff = ox.createImageData(w, h);
        let count = 0;
        for (let i = 0; i < pa.length; i += 4) {
          const same = pa[i] === pb[i] && pa[i + 1] === pb[i + 1] && pa[i + 2] === pb[i + 2];
          if (!same) count++;
          const grey = (pa[i] + pa[i + 1] + pa[i + 2]) / 12;
          diff.data[i] = same ? grey : 255;
          diff.data[i + 1] = same ? grey : 30;
          diff.data[i + 2] = same ? grey : 30;
          diff.data[i + 3] = 255;
        }
        ox.putImageData(diff, 0, 0);
        const blob = await out.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { count, total: w * h, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], png: btoa(binary) };
      },
      { a: toUrl(a), b: toUrl(b) },
    );
    fs.writeFileSync(diffFile, Buffer.from(result.png, 'base64'));
    delete result.png;
    return result;
  } finally {
    await page.close();
  }
}

/** Rows whose text differs (after masking the same spans in text). */
export function textDiff(a, b, masks) {
  const mask = (line) => masks.reduce((s, m) => s.replace(new RegExp(m.re.source, 'g'), (x) => '▒'.repeat(x.length)), line);
  const la = a.split('\n').map(mask);
  const lb = b.split('\n').map(mask);
  const rows = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if ((la[i] ?? '') !== (lb[i] ?? '')) rows.push({ row: i, legacy: la[i] ?? '', next: lb[i] ?? '' });
  }
  return rows;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

export function writeReport(file, results) {
  const rel = (p) => path.relative(path.dirname(file), p);
  const env = results.environment;
  const parts = [];
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><title>Real-terminal check</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#ddd;--bad:#c62828;--good:#2e7d32;--card:#f6f6f6}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#141414;--fg:#eaeaea;--muted:#9a9a9a;--line:#333;--bad:#ef5350;--good:#66bb6a;--card:#1e1e1e}}
:root[data-theme="dark"]{--bg:#141414;--fg:#eaeaea;--muted:#9a9a9a;--line:#333;--bad:#ef5350;--good:#66bb6a;--card:#1e1e1e}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1700px}
h1,h2,h3{font-weight:600} table{border-collapse:collapse;margin:8px 0 20px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid var(--line);padding:4px 10px;text-align:right;white-space:nowrap} th:first-child,td:first-child{text-align:left}
.bad{color:var(--bad);font-weight:600}.good{color:var(--good);font-weight:600}.muted{color:var(--muted)}
.wrap{overflow-x:auto}.shots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:6px}
.shots figure{margin:0}.shots img{width:100%;height:auto;border:1px solid var(--line);background:#000}
figcaption{font-size:12px;color:var(--muted)} pre{background:var(--card);padding:8px;overflow-x:auto;font-size:12px}
details{margin:4px 0 18px} .step{border-top:1px solid var(--line);padding-top:10px;margin-top:14px}
@media (max-width:800px){.shots{grid-template-columns:1fr}}
</style></head><body>`);
  parts.push(`<h1>term2 vs term2-next — real-terminal check</h1>
<p class="muted">Generated ${esc(results.generatedAt)} · issue #140 (flip gate item 5). Legacy is the spec.</p>
<h2>Verdict</h2><ul>
<li>Latency gate: <span class="${results.verdict.latency ? 'good' : 'bad'}">${results.verdict.latency ? 'pass' : 'FAIL'}</span></li>
<li>Screenshot gate: <span class="${results.verdict.screenshots ? 'good' : 'bad'}">${results.verdict.screenshots ? 'pass' : 'FAIL'}</span> (${results.verdict.identicalShots}/${results.verdict.totalShots} pairs identical after masks)</li>
<li>Soak: ${esc(results.verdict.soak)}</li></ul>
<h2>Environment</h2><div class="wrap"><table>
${Object.entries(env)
  .map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:left">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
  .join('')}
</table></div>`);

  for (const size of results.sizes) {
    parts.push(`<h2>${size.cols}×${size.rows}</h2>`);
    if (size.errors?.length) {
      parts.push(`<p class="bad">Parts of this size could not run:</p><pre>${esc(size.errors.join('\n\n'))}</pre>`);
    }
    parts.push(`<h3>Store timings</h3><div class="wrap"><table><tr><th></th><th>startup → composer (ms)</th><th>first /resume → list (ms)</th><th>second /resume → list (ms)</th></tr>
${['legacy', 'next']
  .map((w) => {
    const t = size.store[w] ?? {};
    const stall = (v) => (v !== null && v !== undefined && v > 200 ? 'bad' : '');
    // null after a failure: no list within the paint timeout (the first) or not measured (the second).
    const cell = (v, first) =>
      v === null && t.failed
        ? `<td class="bad">${first ? 'FAIL (no list within 5 s)' : 'not measured'}</td>`
        : `<td class="${stall(v)}">${fmt(v, 0)}</td>`;
    return `<tr><td>${w}</td><td>${fmt(t.startupMs, 0)}</td>${cell(t.firstResumeMs, true)}${cell(t.secondResumeMs, false)}</tr>`;
  })
  .join('')}</table></div>`);
    for (const phase of ['idle', 'streaming']) {
      parts.push(`<h3>Key-to-paint latency — ${phase}</h3><div class="wrap"><table>
<tr><th>class</th><th>legacy p50</th><th>p95</th><th>max</th><th>next p50</th><th>p95</th><th>max</th><th>legacy CPU/key ms</th><th>next CPU/key ms</th><th>legacy bytes/key</th><th>next bytes/key</th><th>next missed</th><th>gate</th></tr>
${CLASSES.map((c) => {
  const l = size.latency[phase].legacy[c];
  const n = size.latency[phase].next[c];
  const g = size.latency[phase].gate[c];
  return `<tr><td>${esc(c)}</td><td>${fmt(l.p50)}</td><td>${fmt(l.p95)}</td><td>${fmt(l.max)}</td><td>${fmt(n.p50)}</td><td>${fmt(n.p95)}</td><td>${fmt(n.max)}</td><td>${fmt(l.cpuMsPerKey)}</td><td>${fmt(n.cpuMsPerKey)}</td><td>${fmt(l.bytesPerKey, 0)}</td><td>${fmt(n.bytesPerKey, 0)}</td><td>${n.missed}/${n.n}</td><td class="${g.na ? 'muted' : g.pass ? 'good' : 'bad'}">${g.na ? 'n/a (neither painted)' : g.pass ? 'pass' : esc(g.reasons.join('; '))}</td></tr>`;
}).join('')}</table></div>`);
      const misses = size.misses?.[phase] ?? [];
      if (misses.length) {
        parts.push(`<details><summary>${misses.length} missed key(s) in ${phase} — screens at the timeout</summary>${misses
          .slice(0, 12)
          .map((m) => `<p><b>${esc(m.cli)}</b> · ${esc(m.name)} #${m.index}</p><pre>${esc(m.screen)}</pre>`)
          .join('')}</details>`);
      }
    }
    parts.push(`<h3>Screenshots</h3><p class="muted">Masks (grey boxes): version, ids, paths, ports, durations/times, spinner frames. Left legacy, middle term2-next, right pixel diff (red).</p>`);
    for (const shot of size.shots) {
      const pct = shot.diff ? ((100 * shot.diff.count) / shot.diff.total).toFixed(2) : '—';
      parts.push(`<div class="step"><b>${esc(shot.step)}</b> — <span class="${shot.identical ? 'good' : 'bad'}">${shot.identical ? 'identical' : `${pct}% pixels differ`}</span>
${shot.notes.length ? `<span class="muted"> · ${esc(shot.notes.join('; '))}</span>` : ''}
<div class="shots"><figure><img loading="lazy" src="${esc(rel(shot.legacy))}"><figcaption>legacy</figcaption></figure>
<figure><img loading="lazy" src="${esc(rel(shot.next))}"><figcaption>term2-next</figcaption></figure>
<figure><img loading="lazy" src="${esc(rel(shot.diffFile))}"><figcaption>diff</figcaption></figure></div>
${shot.rows.length ? `<details><summary>${shot.rows.length} text row(s) differ</summary><pre>${shot.rows
        .slice(0, 40)
        .map((r) => `row ${String(r.row).padStart(2)}  L │${esc(r.legacy)}\n        N │${esc(r.next)}`)
        .join('\n')}</pre></details>` : ''}</div>`);
    }
  }
  if (results.soak?.length) {
    parts.push(`<h2>Soak differences</h2><p class="muted">Reported by the context-free soak agent; every item is unexplained until the owner's team triages it.</p><ol>${results.soak
      .map((d) => `<li><b>unexplained</b> — ${esc(d)}</li>`)
      .join('')}</ol>`);
  }
  parts.push('</body></html>');
  fs.writeFileSync(file, parts.join('\n'));
}
