import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionNetworkAllowStore,
  ProjectNetworkAllowStore,
  isHostAllowed,
  addAllowedHost,
  resetSandboxNetworkStoreForTest,
} from './sandbox-network-store.js';

describe('sandbox-network-store', () => {
  let tempDir: string;

  beforeEach(() => {
    resetSandboxNetworkStoreForTest();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-store-test-'));
  });

  it('SessionNetworkAllowStore stores and checks allowed hosts', () => {
    const store = new SessionNetworkAllowStore();
    expect(store.isAllowed('api.example.com')).toBe(false);

    store.add('api.example.com');
    expect(store.isAllowed('api.example.com')).toBe(true);
    expect(store.isAllowed('api.example.com', 443)).toBe(true);
    expect(store.isAllowed('other.example.com')).toBe(false);
  });

  it('SessionNetworkAllowStore handles specific host:port entries', () => {
    const store = new SessionNetworkAllowStore();
    store.add('api.example.com:8443');

    expect(store.isAllowed('api.example.com', 8443)).toBe(true);
    expect(store.isAllowed('api.example.com', 443)).toBe(false);
  });

  it('ProjectNetworkAllowStore persists allowed hosts to project config file', () => {
    const store = new ProjectNetworkAllowStore(tempDir);
    expect(store.load()).toEqual([]);

    store.append('example.com');
    expect(store.load()).toEqual(['example.com']);
    expect(store.isAllowed('example.com', 443)).toBe(true);

    const configFile = path.join(tempDir, '.term2', 'sandbox-network-hosts.json');
    expect(fs.existsSync(configFile)).toBe(true);

    // Verify a new store instance loads persisted config
    const secondStore = new ProjectNetworkAllowStore(tempDir);
    expect(secondStore.load()).toEqual(['example.com']);
    expect(secondStore.isAllowed('example.com')).toBe(true);
  });

  it('addAllowedHost normalizes standard ports 80 and 443 to host name only', () => {
    addAllowedHost('web.com', 443, 'session', tempDir);
    expect(isHostAllowed('web.com', 8080, tempDir)).toBe(true);

    addAllowedHost('http.com', 80, 'project', tempDir);
    expect(isHostAllowed('http.com', 8080, tempDir)).toBe(true);
  });

  it('ProjectNetworkAllowStore gracefully handles non-string array items or corrupt files', () => {
    const configFile = path.join(tempDir, '.term2', 'sandbox-network-hosts.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });

    // File with non-string elements
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, allowHosts: ['valid.com', 123, null] }));
    const store = new ProjectNetworkAllowStore(tempDir);
    expect(store.load()).toEqual(['valid.com']);

    // Corrupt JSON
    fs.writeFileSync(configFile, '{ invalid json');
    expect(store.load()).toEqual([]);
  });
});
