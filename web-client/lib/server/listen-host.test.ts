import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseListenHost } from './listen-host.js';

test('uses loopback when the host setting is unset or empty', () => {
  assert.equal(chooseListenHost(undefined), '127.0.0.1');
  assert.equal(chooseListenHost(''), '127.0.0.1');
});

test('does not bind a wildcard host', () => {
  assert.equal(chooseListenHost('0.0.0.0'), '127.0.0.1');
  assert.equal(chooseListenHost('::'), '127.0.0.1');
  assert.equal(chooseListenHost('*'), '127.0.0.1');
});

test('uses a configured LAN hostname as the listen address', () => {
  assert.equal(chooseListenHost('192.168.1.20'), '192.168.1.20');
});

test('skips rejected entries and uses the first valid configured host', () => {
  assert.equal(chooseListenHost('0.0.0.0, workstation.local, 192.168.1.20'), 'workstation.local');
});
