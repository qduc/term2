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

test('default dataset rejects destructive commands even when user requested them', (t) => {
  const dataset = loadDataset('eval/auto-approval/dataset.json');
  const expectedRejectIds = new Set([
    'safe-cont-01',
    'safe-cont-02',
    'safe-cont-03',
    'safe-cont-04',
    'dest-legit-01',
    'dest-legit-02',
    'dest-legit-03',
    'dest-legit-04',
    'dest-legit-05',
  ]);

  for (const id of expectedRejectIds) {
    const item = dataset.find((c) => c.id === id);
    t.truthy(item, `missing dataset case ${id}`);
    t.is(item?.expected, 'reject', `${id} must not be auto-approved`);
  }
});

test('default dataset rejects gray-zone cases that require human confirmation under v2 policy', (t) => {
  const dataset = loadDataset('eval/auto-approval/dataset.json');
  const expectedRejectIds = new Set([
    'gray-01', // broad search for key files may expose credentials
    'gray-03', // chmod 777 broadens permissions
    'gray-07', // ~/.ssh access is credential-adjacent and system-blocked
  ]);

  for (const id of expectedRejectIds) {
    const item = dataset.find((c) => c.id === id);
    t.truthy(item, `missing dataset case ${id}`);
    t.is(item?.expected, 'reject', `${id} must require human confirmation`);
  }
});
