import { createApprovalModelClient } from '../../src/app/lib/approval-model.js';
import { SessionContextService } from '../../src/model/traffic-context.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderRegistry as createModels } from '../../src/model/provider.js';
import { createProviderRegistry as createProviders } from '../../src/model/providers/registry.js';
import { createCodexAccountStore } from '../../src/model/providers/codex-auth.js';
import { createSessionAccountStore } from '../../src/model/providers/oauth-session-account.js';
import {
  GrokTokenManager,
  saveGrokTokens,
  getActiveGrokAccount,
  setActiveGrokAccount,
  removeGrokAccount,
} from '../../src/model/providers/grok-auth.js';
import { CodexTokenManager } from '../../src/model/providers/codex.provider.js';
import { createDirectTuiMenus } from '../../src/app/launch-tui-menus.js';
import type { LoggingService } from '../../src/session/logging/logging-service.js';
import { createMockSettingsService } from '../helpers/settings-service.mock.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};
let scratch: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it.each(['codex', 'grok'] as const)(
  'keeps %s account pins across models, transport and generation replacement and shows the attached session',
  async (provider) => {
    scratch = await mkdtemp(path.join(tmpdir(), 'oauth-registry-'));
    vi.stubEnv('TERM2_CONFIG_DIR', scratch);
    const authPath = path.join(scratch, `${provider}-auth.json`);
    const credentials =
      provider === 'codex'
        ? createCodexAccountStore(authPath)
        : {
            upsert(tokens: { access_token: string; account_id: string }) {
              saveGrokTokens({ access_token: tokens.access_token, user_id: tokens.account_id }, authPath);
              return getActiveGrokAccount(authPath)!;
            },
            setActive: (id: string) => setActiveGrokAccount(id, authPath),
            remove: (id: string) => removeGrokAccount(id, authPath),
          };
    const firstAccount = credentials.upsert({ access_token: 'first-fixture-token', account_id: 'first-account' });
    const secondAccount = credentials.upsert({ access_token: 'second-fixture-token', account_id: 'second-account' });
    expect(credentials.setActive(firstAccount.id)).toBe(true);
    const providers = createProviders();
    const actualTokens: string[] = [];
    providers.registerProvider({
      id: `account-fixture-${provider}`,
      label: 'Account fixture',
      fetchModels: async () => [],
      createStreamedModel(_model, deps) {
        const token =
          provider === 'codex'
            ? new CodexTokenManager({
                authPath,
                tokenPathResolver: () => null,
                sessionAccountStore: deps.sessionAccountStore,
              })
            : new GrokTokenManager({
                authPath,
                cliAuthPathResolver: () => null,
                sessionAccountStore: deps.sessionAccountStore,
              });
        return {
          async *stream() {
            actualTokens.push(await token.getOrRefreshAccessToken());
            yield { type: 'completion', responseId: 'fixture', output: [], finishReason: 'stop' };
          },
        };
      },
    });
    const settings = createMockSettingsService({ 'agent.retryAttempts': 0 });
    const sessionAccountStore = createSessionAccountStore();
    const first = createModels({ settings, logger, providers, sessionAccountStore });
    const second = createModels({ settings, logger, providers });
    const execute = async (registry: ReturnType<typeof createModels>, modelName = 'fixture') => {
      const model = registry.resolve({ provider: `account-fixture-${provider}`, model: modelName });
      for await (const event of model.stream(
        { model: model.ref, input: [], tools: [], instructions: '' },
        new AbortController().signal,
      )) {
        expect(['done']).toContain(event.type);
      }
    };
    await execute(first);
    expect(first.sessionAccount(provider)).toBe(firstAccount.id);
    expect(second.sessionAccount(provider)).toBeNull();
    expect(credentials.setActive(secondAccount.id)).toBe(true);
    await execute(second);
    await execute(first);
    await execute(first, 'another-model');
    settings.set('agent.transport', 'http', { persist: false });
    await execute(first);
    const replacement = createModels({ settings, logger, providers, sessionAccountStore });
    await execute(replacement);
    const advisorySelection = {
      settings,
      logger: logger as unknown as LoggingService,
      providers,
      sessionAccountStore,
      sessionContext: new SessionContextService(),
    };
    const advisoryModels = createModels(advisorySelection);
    const advisory = createApprovalModelClient(advisoryModels, advisorySelection, new AbortController().signal, {
      conversationKey: 'session',
    });
    await advisory.chat('Check this tool request', {
      provider: `account-fixture-${provider}`,
      model: 'advisory-model',
    });
    expect(advisoryModels.sessionAccount(provider)).toBe(firstAccount.id);
    expect(actualTokens).toEqual([
      'first-fixture-token',
      'second-fixture-token',
      'first-fixture-token',
      'first-fixture-token',
      'first-fixture-token',
      'first-fixture-token',
      'first-fixture-token',
    ]);
    expect(first.sessionAccount(provider)).toBe(firstAccount.id);
    expect(second.sessionAccount(provider)).toBe(secondAccount.id);

    const menus = createDirectTuiMenus({
      app: {
        liveSettings: () => settings,
        skills: () => [],
        listWorkspaceSessions: async () => ({ sessions: [] }),
        sessionAccount: (sessionId, providerId) =>
          (sessionId === 'first-session' ? first : second).sessionAccount(providerId),
      },
      persistentSettings: settings,
      logger: logger as unknown as LoggingService,
      root: scratch,
    });
    const firstView = menus.providers!.listAccounts('first-session', provider);
    expect(firstView.map(({ id, isSelected, isInUse }) => ({ id, isSelected, isInUse }))).toEqual([
      { id: firstAccount.id, isSelected: false, isInUse: true },
      { id: secondAccount.id, isSelected: true, isInUse: false },
    ]);
    expect(menus.providers!.sessionAccount('first-session', provider)).toBe(firstAccount.id);
    expect(
      menus.providers!.listAccounts('second-session', provider).find((account) => account.id === secondAccount.id)
        ?.isInUse,
    ).toBe(true);
    expect(credentials.remove(firstAccount.id)).toBe(true);
    await execute(first);
    await execute(replacement);
    expect(actualTokens.slice(-2)).toEqual(['second-fixture-token', 'second-fixture-token']);
    expect(first.sessionAccount(provider)).toBe(secondAccount.id);
    expect(menus.providers!.sessionAccount('first-session', provider)).toBe(secondAccount.id);
  },
);
