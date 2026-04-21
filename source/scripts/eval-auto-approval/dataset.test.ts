import test from 'ava';
import { loadDataset, filterDataset } from './dataset.js';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = join(tmpdir(), 'dataset-test-' + Math.random().toString(36).slice(2));

test.before(() => {
  mkdirSync(tmpDir, { recursive: true });
});

test.after.always(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test('loadDataset validates correct dataset', (t) => {
  const path = join(tmpDir, 'valid.json');
  const data = [
    {
      id: 'test-1',
      command: 'ls',
      history: [{ role: 'user', content: 'list' }],
      expected: 'approve',
      category: 'safe',
      severity: 'low',
    },
  ];
  writeFileSync(path, JSON.stringify(data));

  const loaded = loadDataset(path);
  t.is(loaded.length, 1);
  t.is(loaded[0].id, 'test-1');
});

test('loadDataset fails on invalid dataset', (t) => {
  const path = join(tmpDir, 'invalid.json');
  const data = [
    {
      id: 'test-1',
      command: 'ls',
      // missing history
      expected: 'approve',
      category: 'safe',
      severity: 'low',
    },
  ];
  writeFileSync(path, JSON.stringify(data));

  t.throws(() => loadDataset(path), { message: /Validation failed for case "test-1"/ });
});

test('filterDataset filters correctly', (t) => {
  const cases: any[] = [
    { id: '1', category: 'A', severity: 'low' },
    { id: '2', category: 'B', severity: 'high' },
    { id: '3', category: 'A', severity: 'high' },
  ];

  t.is(filterDataset(cases, { category: 'A' }).length, 2);
  t.is(filterDataset(cases, { severity: 'high' }).length, 2);
  t.is(filterDataset(cases, { category: 'A', severity: 'high' }).length, 1);
  t.is(filterDataset(cases, { ids: ['1', '2'] }).length, 2);
});
