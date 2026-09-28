import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function element() {
  return {
    value: '', textContent: '', children: [], listeners: {},
    append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    change(value) { this.value = value; this.listeners.input(); },
  };
}

async function page(rows) {
  const ids = Object.fromEntries(['runs', 'candidates', 'evaluated', 'judged', 'search',
    'task', 'model', 'outcome', 'count', 'rows', 'comparison-run', 'comparison',
    'comparison-rows'].map(id => [id, element()]));
  const document = {
    getElementById: id => ids[id],
    createElement: () => element(),
    createDocumentFragment: () => Object.assign(element(), { fragment: true }),
  };
  runInNewContext(script, { document, fetch: async () => ({ ok: true, json: async () => rows }), Set });
  await new Promise(resolve => setImmediate(resolve));
  return ids;
}

const candidate = (run_id, name, fields = {}) => ({ run_id, name, task_id: 'socket',
  created_at: '2026-09-28', comparison_mode: 'model-comparison', harness: 'term2',
  model_id: name, effort: 'medium', run_status: 'OK', evaluator_status: 'PASS',
  judge_mean: 7, judge_samples: 2, duration_seconds: 100, cost_usd: 0.02, ...fields });

test('comparison keeps cohorts separate even when task and model match', async () => {
  const ids = await page([candidate(1, 'flash'), candidate(1, 'pro'),
    candidate(2, 'flash', { judge_mean: 9 })]);
  ids['comparison-run'].change('1');
  assert.equal(ids['comparison-rows'].children.length, 2);
  assert.match(ids.comparison.textContent, /run #1/);
  ids['comparison-run'].change('2');
  assert.equal(ids['comparison-rows'].children.length, 1);
  assert.match(ids.comparison.textContent, /inconclusive/i);
});

test('missing evaluation or judge scores are not treated as a winner', async () => {
  const ids = await page([candidate(1, 'flash', { evaluator_status: null, judge_mean: null }),
    candidate(1, 'pro')]);
  ids['comparison-run'].change('1');
  assert.match(ids.comparison.textContent, /inconclusive/i);
  assert.match(ids['comparison-rows'].children[0].children.map(c => c.textContent).join(' '), /—/);
});

test('task filter narrows eligible comparison runs without mixing tasks', async () => {
  const ids = await page([candidate(1, 'flash'),
    candidate(2, 'pro', { task_id: 'retry' })]);
  ids.task.change('retry');
  assert.equal(ids['comparison-run'].children.length, 1);
  assert.equal(ids['comparison-run'].value, '2');
  assert.match(ids.comparison.textContent, /retry · run #2/);
});
