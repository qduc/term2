import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { parseSSHConfig, resolveSSHHost } from './ssh-config-parser.js';

it('parseSSHConfig parses simple host entry', () => {
  const config = `
Host docker
    HostName 192.168.1.100
    User myuser
    Port 2222
`;
  const result = parseSSHConfig(config);
  expect(result['docker']).toEqual({
    hostName: '192.168.1.100',
    user: 'myuser',
    port: 2222,
  });
});

it('parseSSHConfig parses multiple host entries', () => {
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
  expect(Object.keys(result).length).toBe(2);
  expect(result['docker']?.hostName).toBe('192.168.1.100');
  expect(result['staging']?.hostName).toBe('staging.example.com');
});

it('parseSSHConfig handles IdentityFile', () => {
  const config = `
Host myserver
    HostName server.example.com
    User admin
    IdentityFile ~/.ssh/mykey
`;
  const result = parseSSHConfig(config);
  expect(result['myserver']?.identityFile).toBe('~/.ssh/mykey');
});

it('parseSSHConfig handles case-insensitive keywords', () => {
  const config = `
Host test
    hostname example.com
    user testuser
    port 2222
`;
  const result = parseSSHConfig(config);
  expect(result['test']?.hostName).toBe('example.com');
  expect(result['test']?.user).toBe('testuser');
  expect(result['test']?.port).toBe(2222);
});

it('parseSSHConfig ignores comments and empty lines', () => {
  const config = `
# This is a comment
Host docker
    # Another comment
    HostName 192.168.1.100

    User myuser
`;
  const result = parseSSHConfig(config);
  expect(result['docker']?.hostName).toBe('192.168.1.100');
  expect(result['docker']?.user).toBe('myuser');
});

it('parseSSHConfig handles wildcard hosts', () => {
  const config = `
Host *
    User defaultuser
    Port 22

Host docker
    HostName 192.168.1.100
`;
  const result = parseSSHConfig(config);
  expect(result['*']).toBeTruthy();
  expect(result['*']?.user).toBe('defaultuser');
});

it('resolveSSHHost returns config for matching host', () => {
  const config = `
Host docker
    HostName 192.168.1.100
    User myuser
    Port 2222
`;
  const result = resolveSSHHost('docker', config);
  expect(result).toEqual({
    hostName: '192.168.1.100',
    user: 'myuser',
    port: 2222,
  });
});

it('resolveSSHHost returns undefined for non-matching host', () => {
  const config = `
Host docker
    HostName 192.168.1.100
`;
  const result = resolveSSHHost('unknown', config);
  expect(result).toBe(undefined);
});

it('resolveSSHHost merges wildcard defaults', () => {
  const config = `
Host *
    User defaultuser
    Port 22

Host docker
    HostName 192.168.1.100
`;
  const result = resolveSSHHost('docker', config);
  expect(result?.hostName).toBe('192.168.1.100');
  expect(result?.user).toBe('defaultuser');
  expect(result?.port).toBe(22);
});

it('resolveSSHHost host-specific values override wildcards', () => {
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
  expect(result?.hostName).toBe('192.168.1.100');
  expect(result?.user).toBe('docker-user');
  expect(result?.port).toBe(2222);
});

it('parseSSHConfig handles tabs and spaces', () => {
  const config = `
Host docker
	HostName 192.168.1.100
    User myuser
`;
  const result = parseSSHConfig(config);
  expect(result['docker']?.hostName).toBe('192.168.1.100');
  expect(result['docker']?.user).toBe('myuser');
});

it('parseSSHConfig handles Host with equals sign format', () => {
  const config = `
Host docker
    HostName=192.168.1.100
    User=myuser
`;
  const result = parseSSHConfig(config);
  expect(result['docker']?.hostName).toBe('192.168.1.100');
  expect(result['docker']?.user).toBe('myuser');
});
