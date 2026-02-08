import test from 'ava';
import { parseSSHConfig, resolveSSHHost } from './ssh-config-parser.js';

test('parseSSHConfig parses simple host entry', (t) => {
  const config = `
Host docker
    HostName 192.168.1.100
    User myuser
    Port 2222
`;
  const result = parseSSHConfig(config);
  t.deepEqual(result['docker'], {
    hostName: '192.168.1.100',
    user: 'myuser',
    port: 2222,
  });
});

test('parseSSHConfig parses multiple host entries', (t) => {
  const config = `
Host docker
    HostName 192.168.1.100
    User docker-user

Host staging
    HostName staging.example.com
    User deploy
    Port 22
`;
  const result = parseSSHConfig(config);
  t.is(Object.keys(result).length, 2);
  t.is(result['docker']?.hostName, '192.168.1.100');
  t.is(result['staging']?.hostName, 'staging.example.com');
});

test('parseSSHConfig handles IdentityFile', (t) => {
  const config = `
Host myserver
    HostName server.example.com
    User admin
    IdentityFile ~/.ssh/mykey
`;
  const result = parseSSHConfig(config);
  t.is(result['myserver']?.identityFile, '~/.ssh/mykey');
});

test('parseSSHConfig handles case-insensitive keywords', (t) => {
  const config = `
Host test
    hostname example.com
    user testuser
    port 2222
`;
  const result = parseSSHConfig(config);
  t.is(result['test']?.hostName, 'example.com');
  t.is(result['test']?.user, 'testuser');
  t.is(result['test']?.port, 2222);
});

test('parseSSHConfig ignores comments and empty lines', (t) => {
  const config = `
# This is a comment
Host docker
    # Another comment
    HostName 192.168.1.100

    User myuser
`;
  const result = parseSSHConfig(config);
  t.is(result['docker']?.hostName, '192.168.1.100');
  t.is(result['docker']?.user, 'myuser');
});

test('parseSSHConfig handles wildcard hosts', (t) => {
  const config = `
Host *
    User defaultuser
    Port 22

Host docker
    HostName 192.168.1.100
`;
  const result = parseSSHConfig(config);
  t.truthy(result['*']);
  t.is(result['*']?.user, 'defaultuser');
});

test('resolveSSHHost returns config for matching host', (t) => {
  const config = `
Host docker
    HostName 192.168.1.100
    User myuser
    Port 2222
`;
  const result = resolveSSHHost('docker', config);
  t.deepEqual(result, {
    hostName: '192.168.1.100',
    user: 'myuser',
    port: 2222,
  });
});

test('resolveSSHHost returns undefined for non-matching host', (t) => {
  const config = `
Host docker
    HostName 192.168.1.100
`;
  const result = resolveSSHHost('unknown', config);
  t.is(result, undefined);
});

test('resolveSSHHost merges wildcard defaults', (t) => {
  const config = `
Host *
    User defaultuser
    Port 22

Host docker
    HostName 192.168.1.100
`;
  const result = resolveSSHHost('docker', config);
  t.is(result?.hostName, '192.168.1.100');
  t.is(result?.user, 'defaultuser');
  t.is(result?.port, 22);
});

test('resolveSSHHost host-specific values override wildcards', (t) => {
  const config = `
Host *
    User defaultuser
    Port 22

Host docker
    HostName 192.168.1.100
    User docker-user
    Port 2222
`;
  const result = resolveSSHHost('docker', config);
  t.is(result?.hostName, '192.168.1.100');
  t.is(result?.user, 'docker-user');
  t.is(result?.port, 2222);
});

test('parseSSHConfig handles tabs and spaces', (t) => {
  const config = `
Host docker
	HostName 192.168.1.100
    User myuser
`;
  const result = parseSSHConfig(config);
  t.is(result['docker']?.hostName, '192.168.1.100');
  t.is(result['docker']?.user, 'myuser');
});

test('parseSSHConfig handles Host with equals sign format', (t) => {
  const config = `
Host docker
    HostName=192.168.1.100
    User=myuser
`;
  const result = parseSSHConfig(config);
  t.is(result['docker']?.hostName, '192.168.1.100');
  t.is(result['docker']?.user, 'myuser');
});
