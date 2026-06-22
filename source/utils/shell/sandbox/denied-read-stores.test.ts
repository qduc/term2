import { it, expect, describe, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeniedReadStore,
  ExecutionOverrideStore,
  ProjectSandboxAllowReadStore,
  type ExecutionOverride,
} from './denied-read-stores.js';
import type { DeniedReadInfo } from './denied-read-detector.js';

function makeInfo(p: string, sensitive = false): DeniedReadInfo {
  return { path: p, suggestedParent: p, sensitive };
}

describe('DeniedReadStore', () => {
  it('records and consumes a denied-read entry by command string', () => {
    const store = new DeniedReadStore();
    store.record('cat ~/.cache/x', makeInfo('/home/u/.cache/x'));
    expect(store.has('cat ~/.cache/x')).toBe(true);
    const consumed = store.consume('cat ~/.cache/x');
    expect(consumed).not.toBeNull();
    expect(consumed!.path).toBe('/home/u/.cache/x');
    // consume is destructive
    expect(store.has('cat ~/.cache/x')).toBe(false);
    expect(store.consume('cat ~/.cache/x')).toBeNull();
  });

  it('peeks without consuming', () => {
    const store = new DeniedReadStore();
    store.record('cargo build', makeInfo('/home/u/.cargo'));
    expect(store.peek('cargo build')?.path).toBe('/home/u/.cargo');
    expect(store.has('cargo build')).toBe(true);
  });

  it('re-stages a consumed entry by callId for the approval-result builder', () => {
    const store = new DeniedReadStore();
    store.record('ls ~/.m2', makeInfo('/home/u/.m2'));
    store.consume('ls ~/.m2');
    // After consume, re-stage for the descriptor builder.
    store.stageForDescriptor('call-1', makeInfo('/home/u/.m2'));
    expect(store.consumeStaged('call-1')?.path).toBe('/home/u/.m2');
    expect(store.consumeStaged('call-1')).toBeNull();
  });

  it('returns null for unknown commands', () => {
    const store = new DeniedReadStore();
    expect(store.consume('unknown')).toBeNull();
    expect(store.peek('unknown')).toBeNull();
  });
});

describe('ExecutionOverrideStore', () => {
  it('sets and consumes an override by callId', () => {
    const store = new ExecutionOverrideStore();
    const override: ExecutionOverride = { extraAllowRead: ['/home/u/.cargo'] };
    store.set('call-1', override);
    const consumed = store.consume('call-1');
    expect(consumed).toEqual(override);
    // consume is destructive
    expect(store.consume('call-1')).toBeNull();
  });

  it('supports forceUnsandboxed override', () => {
    const store = new ExecutionOverrideStore();
    store.set('call-2', { forceUnsandboxed: true });
    expect(store.consume('call-2')).toEqual({ forceUnsandboxed: true });
  });

  it('returns null for unknown callId', () => {
    const store = new ExecutionOverrideStore();
    expect(store.consume('unknown')).toBeNull();
  });
});

describe('ProjectSandboxAllowReadStore', () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-store-test-'));
    workspaceRoot = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty list when no project config exists', () => {
    const store = new ProjectSandboxAllowReadStore(workspaceRoot);
    expect(store.load()).toEqual([]);
  });

  it('appends a path and persists it for subsequent loads', () => {
    const store = new ProjectSandboxAllowReadStore(workspaceRoot);
    store.append('/home/u/.cargo');
    expect(store.load()).toEqual(['/home/u/.cargo']);
    // A fresh instance reads from disk.
    const store2 = new ProjectSandboxAllowReadStore(workspaceRoot);
    expect(store2.load()).toEqual(['/home/u/.cargo']);
  });

  it('dedupes identical paths', () => {
    const store = new ProjectSandboxAllowReadStore(workspaceRoot);
    store.append('/home/u/.cargo');
    store.append('/home/u/.cargo');
    expect(store.load()).toEqual(['/home/u/.cargo']);
  });

  it('preserves order across distinct paths', () => {
    const store = new ProjectSandboxAllowReadStore(workspaceRoot);
    store.append('/home/u/.cargo');
    store.append('/home/u/.m2/repository');
    expect(store.load()).toEqual(['/home/u/.cargo', '/home/u/.m2/repository']);
  });

  it('tolerates a corrupt config file by returning an empty list', () => {
    const dir = path.join(workspaceRoot, '.term2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sandbox-allow-paths.json'), 'not valid json{{');
    const store = new ProjectSandboxAllowReadStore(workspaceRoot);
    expect(store.load()).toEqual([]);
  });
});
