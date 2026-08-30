import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAvailableProviderIds,
  getProviderCredentialSettingKey,
  getProviderIdForCredentialSettingKey,
  hasProviderCredentials,
  resolveProviderCredentialValue,
  resolveProviderCredentials,
} from './provider-credentials.js';
import { unregisterProvider, upsertProvider } from '../../providers/registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('uses Codex auth-file presence without reading or validating token contents', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-codex-readiness-'));
  const codexHome = path.join(home, 'codex');
  fs.mkdirSync(codexHome);
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('CHATGPT_LOCAL_HOME', '');
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('TERM2_CONFIG_DIR', path.join(home, 'term2'));

  try {
    expect(resolveProviderCredentials({ getDynamic: () => undefined } as any, 'codex')).toMatchObject({
      required: true,
      configured: false,
      source: 'missing',
      unavailableReason: 'missing-codex-login',
    });
    expect(getAvailableProviderIds({ getDynamic: () => undefined } as any, ['codex'])).toEqual([]);

    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{ this is intentionally not a token payload }');
    expect(resolveProviderCredentials({ getDynamic: () => undefined } as any, 'codex')).toMatchObject({
      required: true,
      configured: true,
      source: 'token-file',
      credentialPath: path.join(codexHome, 'auth.json'),
    });
    expect(getAvailableProviderIds({ getDynamic: () => undefined } as any, ['codex'])).toEqual(['codex']);
  } finally {
    homedirSpy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it('uses configured settings or host environment credentials without validating them', () => {
  const settings = {
    getDynamic: (key: string) => (key === 'agent.openrouter.apiKey' ? 'not-a-real-key' : undefined),
  } as any;

  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  expect(hasProviderCredentials(settings, 'openrouter')).toBe(true);
  expect(hasProviderCredentials(settings, 'openai')).toBe(false);

  vi.stubEnv('OPENAI_API_KEY', 'host-key');
  expect(hasProviderCredentials(settings, 'openai')).toBe(true);
});

it('filters only credential-dependent first-party providers from model selection', () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const settings = { getDynamic: () => undefined } as any;

  expect(getAvailableProviderIds(settings, ['openai', 'openrouter', 'custom-local'])).toEqual(['custom-local']);
});

it('exposes the shared setting keys used by credential setup and readiness', () => {
  expect(getProviderCredentialSettingKey('openai')).toBe('agent.openai.apiKey');
  expect(getProviderCredentialSettingKey('openrouter')).toBe('agent.openrouter.apiKey');
  expect(getProviderCredentialSettingKey('custom-local')).toBeUndefined();
  expect(getProviderIdForCredentialSettingKey('agent.openrouter.apiKey')).toBe('openrouter');
});

it('requires credentials for remote custom providers and resolves stored or type environment keys', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
  const settings = {
    getDynamic: (key: string) => {
      if (key === 'providers') {
        return [
          {
            id: 'remote-openai',
            name: 'Remote OpenAI',
            type: 'openai-compatible',
            baseUrl: 'https://llm.example.test/v1',
          },
          { id: 'remote-anthropic', name: 'Remote Anthropic', type: 'anthropic' },
          { id: 'stored-google', name: 'Stored Google', type: 'google', apiKey: 'stored-google-key' },
        ];
      }
      return undefined;
    },
  } as any;

  expect(resolveProviderCredentials(settings, 'remote-openai')).toMatchObject({
    required: true,
    configured: false,
  });
  expect(resolveProviderCredentials(settings, 'remote-anthropic')).toMatchObject({
    required: true,
    configured: true,
    source: 'environment',
  });
  expect(resolveProviderCredentials(settings, 'stored-google')).toMatchObject({
    required: true,
    configured: true,
    source: 'stored',
  });
  expect(resolveProviderCredentialValue(settings, 'remote-anthropic')).toBe('env-anthropic-key');
  expect(resolveProviderCredentialValue(settings, 'stored-google')).toBe('stored-google-key');
  expect(getAvailableProviderIds(settings, ['remote-openai', 'remote-anthropic', 'stored-google'])).toEqual([
    'remote-anthropic',
    'stored-google',
  ]);
});

it('preserves explicitly no-auth local custom providers', () => {
  const settings = {
    getDynamic: (key: string) =>
      key === 'providers'
        ? [
            { id: 'local-llama', name: 'Local Llama', type: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
            {
              id: 'local-compatible',
              name: 'Local Compatible',
              type: 'openai-compatible',
              baseUrl: 'http://localhost:1234/v1',
            },
          ]
        : undefined,
  } as any;

  expect(resolveProviderCredentials(settings, 'local-llama')).toMatchObject({
    required: false,
    configured: true,
    source: 'local',
  });
  expect(resolveProviderCredentials(settings, 'local-compatible')).toMatchObject({
    required: false,
    configured: true,
    source: 'local',
  });
});

it('retains an optional stored key for local runtime setup without changing no-auth readiness', () => {
  const settings = {
    getDynamic: (key: string) =>
      key === 'providers'
        ? [
            {
              id: 'local-compatible',
              name: 'Local Compatible',
              type: 'openai-compatible',
              baseUrl: 'http://localhost:1234/v1',
              apiKey: 'optional-local-key',
            },
          ]
        : undefined,
  } as any;

  expect(hasProviderCredentials(settings, 'local-compatible')).toBe(true);
  expect(resolveProviderCredentialValue(settings, 'local-compatible')).toBe('optional-local-key');
});

it('does not treat an unconfigured runtime-defined provider as runnable', () => {
  const providerId = `runtime-remote-${Date.now()}`;
  upsertProvider({ id: providerId, label: providerId, isRuntimeDefined: true, fetchModels: async () => [] });
  try {
    expect(resolveProviderCredentials({ getDynamic: () => undefined } as any, providerId)).toMatchObject({
      required: true,
      configured: false,
    });
  } finally {
    unregisterProvider(providerId);
  }
});
