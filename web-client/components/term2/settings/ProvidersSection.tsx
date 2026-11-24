'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, CircleAlert, ExternalLink, Loader2, Plus, RefreshCw, Search, Server } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { term2Client } from '../../../lib/api/term2';
import type { ModelSummary, ProviderPresetEntry, SettingsProjection } from '../../../lib/term2/types';
import { CredentialField, credentialSourceText } from './CredentialField';

type Provider = SettingsProjection['settings']['providers'][number];
type Tone = 'ok' | 'warn' | 'error' | 'off' | 'pending';

/** `?provider=new` opens the add-provider gallery instead of a provider. */
export const ADD_PROVIDER_ROUTE = 'new';

const TYPE_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI-compatible',
  openai: 'OpenAI Responses',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  'llama.cpp': 'llama.cpp',
};

const CATEGORY_LABELS: Record<string, string> = {
  'model-api': 'Model APIs',
  gateway: 'Gateways',
  inference: 'Inference hosts',
  local: 'Local servers',
  subscription: 'Subscriptions',
};

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  off: 'bg-zinc-300 dark:bg-zinc-600',
  pending: 'bg-zinc-400 animate-pulse',
};

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

interface ProviderState {
  tone: Tone;
  text: string;
  shortText: string;
}

function providerState(
  provider: Provider,
  isOAuth: boolean,
  modelCount: number,
  modelsChecked: boolean,
  modelsLoading: boolean,
): ProviderState {
  if (provider.disabled) return { tone: 'off', text: 'Off', shortText: 'Off' };
  const credential = provider.credential;
  if (!credential.configured)
    return isOAuth
      ? { tone: 'warn', text: 'Not signed in', shortText: 'Not signed in' }
      : { tone: 'warn', text: 'Needs an API key', shortText: 'Needs a key' };
  const how =
    credential.source === 'token-file'
      ? 'Connected with sign-in'
      : credential.source === 'local'
        ? 'Connected to local server'
        : credential.source === 'external'
          ? 'Connected'
          : 'Connected with API key';
  if (modelCount > 0)
    return {
      tone: 'ok',
      text: `${how} · ${modelCount} model${modelCount === 1 ? '' : 's'}`,
      shortText: `${modelCount} model${modelCount === 1 ? '' : 's'}`,
    };
  if (modelsLoading || !modelsChecked) return { tone: 'pending', text: `${how} · checking models…`, shortText: 'Checking…' };
  return {
    tone: 'error',
    text: "Couldn't load models. Check the key or the server address.",
    shortText: "Can't load models",
  };
}

function docsUrlFor(provider: Provider, presets: ProviderPresetEntry[]): string | undefined {
  return (
    presets.find((preset) => preset.builtinProviderId === provider.id)?.docsUrl ??
    presets.find((preset) => preset.id === provider.id)?.docsUrl
  );
}

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

export function ProvidersSection({
  projection,
  models,
  modelsLoading,
  modelsChecked,
  presets,
  providerTypes,
  routeProvider,
  onNavigate,
  onReload,
  onModelsChanged,
}: {
  projection: SettingsProjection;
  models: ModelSummary[];
  modelsLoading: boolean;
  modelsChecked: boolean;
  presets: ProviderPresetEntry[];
  providerTypes: string[];
  /** The `?provider=` URL value: a provider id, the add gallery, or nothing (list only on narrow screens). */
  routeProvider: string | null;
  onNavigate: (provider: string | null) => void;
  onReload: () => Promise<SettingsProjection | null>;
  onModelsChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const providers = projection.settings.providers;
  const oauth = projection.settings.oauthAccounts;
  const defaultProvider = (
    projection.settings.safeDefaults['agent.modelSelection']?.value as { provider?: string } | undefined
  )?.provider;

  const modelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    return counts;
  }, [models]);

  const sorted = useMemo(() => {
    const rank = (provider: Provider) =>
      provider.id === defaultProvider
        ? 0
        : provider.disabled
          ? 3
          : provider.credential.configured
            ? 1
            : 2;
    return [...providers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'en'));
  }, [providers, defaultProvider]);

  const stateOf = (provider: Provider) =>
    providerState(provider, provider.id in oauth, modelCounts.get(provider.id) ?? 0, modelsChecked, modelsLoading);

  const adding = routeProvider === ADD_PROVIDER_ROUTE;
  const selected = adding ? null : (providers.find((p) => p.id === routeProvider) ?? (routeProvider ? null : sorted[0]));
  // Narrow screens show the list until a provider is chosen, then only the detail page.
  const detailOpen = routeProvider !== null;

  return (
    <div className="flex min-h-0 flex-col gap-4 md:flex-row md:gap-6">
      <div className={cn('md:w-60 md:shrink-0', detailOpen && 'hidden md:block')}>
        <ul aria-label="Providers" className="space-y-0.5">
          {sorted.map((provider) => {
            const state = stateOf(provider);
            const isSelected = !adding && selected?.id === provider.id;
            return (
              <li key={provider.id}>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => onNavigate(provider.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted',
                    isSelected && 'bg-muted',
                  )}
                >
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[state.tone])} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">{provider.label}</span>
                      {provider.isCustom && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
                          custom
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {provider.id === defaultProvider ? `Default · ${state.shortText}` : state.shortText}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant={adding ? 'secondary' : 'ghost'}
          size="sm"
          className="mt-2 w-full justify-start text-muted-foreground"
          onClick={() => onNavigate(ADD_PROVIDER_ROUTE)}
        >
          <Plus />
          Add provider
        </Button>
      </div>

      <div className={cn('min-w-0 flex-1', !detailOpen && 'hidden md:block')}>
        {detailOpen && (
          <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-3 md:hidden" onClick={() => onNavigate(null)}>
            <ArrowLeft />
            All providers
          </Button>
        )}
        {adding ? (
          <AddProvider
            presets={presets}
            providerTypes={providerTypes}
            existingIds={new Set(providers.map((p) => p.id))}
            onOpenExisting={onNavigate}
            onAdded={async (before) => {
              const latest = await onReload();
              await onModelsChanged();
              const added = latest?.settings.providers.find((p) => !before.has(p.id));
              onNavigate(added?.id ?? null);
            }}
          />
        ) : selected ? (
          <ProviderDetail
            key={selected.id}
            provider={selected}
            state={stateOf(selected)}
            isDefault={selected.id === defaultProvider}
            canEditKey={selected.id in projection.settings.credentials}
            accounts={oauth[selected.id]}
            models={models.filter((m) => m.provider === selected.id)}
            modelsLoading={modelsLoading}
            presets={presets}
            providerTypes={providerTypes}
            onReload={onReload}
            onModelsChanged={onModelsChanged}
            onConfirm={setConfirm}
            onRemoved={() => onNavigate(null)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            That provider no longer exists.{' '}
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onNavigate(null)}>
              Show all providers
            </Button>
          </p>
        )}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const pending = confirm;
                setConfirm(null);
                if (pending) void pending.action();
              }}
            >
              {confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t py-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ProviderDetail({
  provider,
  state,
  isDefault,
  canEditKey,
  accounts,
  models,
  modelsLoading,
  presets,
  providerTypes,
  onReload,
  onModelsChanged,
  onConfirm,
  onRemoved,
}: {
  provider: Provider;
  state: ProviderState;
  isDefault: boolean;
  canEditKey: boolean;
  accounts?: SettingsProjection['settings']['oauthAccounts'][string];
  models: ModelSummary[];
  modelsLoading: boolean;
  presets: ProviderPresetEntry[];
  providerTypes: string[];
  onReload: () => Promise<SettingsProjection | null>;
  onModelsChanged: () => Promise<void>;
  onConfirm: (request: ConfirmRequest) => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const docsUrl = docsUrlFor(provider, presets);
  const isOAuth = accounts !== undefined;

  /** Runs one change, then refreshes settings and the model list so the status line is current. */
  const run = async (operation: () => Promise<string | null>, failure: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const done = await operation();
      await onReload();
      await onModelsChanged();
      if (done) setNotice({ tone: 'ok', text: done });
      return true;
    } catch (reason) {
      setNotice({ tone: 'error', text: errorText(reason, failure) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) =>
    void run(async () => {
      const result = await term2Client.writeProvider({ action: 'toggle', id: provider.id, disabled: !enabled });
      if (!result.ok) throw new Error(result.error ?? `Could not turn ${provider.label} ${enabled ? 'on' : 'off'}.`);
      return null;
    }, `Could not turn ${provider.label} ${enabled ? 'on' : 'off'}.`);

  const testConnection = () =>
    void (async () => {
      setBusy(true);
      setNotice(null);
      try {
        await onModelsChanged();
      } finally {
        setBusy(false);
        setNotice({ tone: 'ok', text: 'Checked just now.' });
      }
    })();

  const visibleModels = showAllModels ? models : models.slice(0, 10);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{provider.label}</h2>
            {isDefault && (
              <Badge variant="secondary" title="The saved default model comes from this provider">
                Default
              </Badge>
            )}
            {provider.isCustom && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                custom
              </Badge>
            )}
          </div>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[state.tone])} />
            {state.text}
          </p>
        </div>
        <Switch
          checked={!provider.disabled}
          disabled={busy}
          aria-label={provider.disabled ? `Turn ${provider.label} on` : `Turn ${provider.label} off`}
          onCheckedChange={toggle}
          className="mt-1.5"
        />
      </div>

      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'mb-3 flex items-center gap-1.5 text-sm',
            notice.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {notice.tone === 'error' && <CircleAlert className="size-4 shrink-0" />}
          {notice.text}
        </p>
      )}

      <SectionBlock title="Connection">
        {canEditKey && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">API key</p>
              {!provider.credential.configured && (
                <p className="text-sm text-muted-foreground">Paste a key from your {provider.label} account.</p>
              )}
            </div>
            <CredentialField
              id={provider.id}
              label={`${provider.label} API key`}
              credential={provider.credential}
              disabled={busy}
              onSave={(value) =>
                run(async () => {
                  await term2Client.setCredential(provider.id, value);
                  return 'API key saved.';
                }, 'The API key was not saved.')
              }
              onRemove={() =>
                onConfirm({
                  title: `Remove ${provider.label} API key`,
                  description: `term2 forgets the saved key for ${provider.label}. Chats using it stop working until you add a key again.`,
                  confirmLabel: 'Remove key',
                  action: async () => {
                    await run(async () => {
                      await term2Client.deleteCredential(provider.id);
                      return 'API key removed.';
                    }, 'The API key was not removed.');
                  },
                })
              }
            />
          </div>
        )}

        {isOAuth && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">Sign-in accounts</p>
                <p className="text-sm text-muted-foreground">
                  {accounts.length === 0
                    ? `Sign in with your ${provider.label} subscription. A browser tab opens to finish.`
                    : 'term2 uses the active account.'}
                </p>
              </div>
              <Button
                type="button"
                variant={accounts.length === 0 ? 'default' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => {
                  setNotice({ tone: 'ok', text: `Finish signing in to ${provider.label} in the browser tab that opened…` });
                  void run(async () => {
                    const result = await term2Client.oauthLogin(provider.id);
                    if (result.status !== 'completed') throw new Error('Sign-in was not completed. Try again.');
                    return `Signed in to ${provider.label}.`;
                  }, 'Sign-in failed.');
                }}
              >
                {busy && <Loader2 className="animate-spin" />}
                {accounts.length === 0 ? 'Sign in' : 'Add account'}
              </Button>
            </div>
            {accounts.length > 0 && (
              <ul className="mt-3 divide-y rounded-lg border">
                {accounts.map((account) => (
                  <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-foreground">{account.label}</span>
                      {account.isSelected && <Badge variant="secondary">Active</Badge>}
                      {account.isInUse && !account.isSelected && (
                        <Badge variant="outline" className="font-normal">
                          In use
                        </Badge>
                      )}
                    </span>
                    <span className="flex gap-1">
                      {!account.isSelected && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await term2Client.oauthSelect(provider.id, account.id);
                              if (!result.ok) throw new Error('Could not switch accounts.');
                              return `Now using ${account.label}.`;
                            }, 'Could not switch accounts.')
                          }
                        >
                          Use this account
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          onConfirm({
                            title: `Sign out of ${account.label}`,
                            description: `term2 deletes its saved sign-in for ${account.label}. You can sign in again later.`,
                            confirmLabel: 'Sign out',
                            action: async () => {
                              await run(async () => {
                                const result = await term2Client.oauthDelete(provider.id, account.id);
                                if (!result.ok) throw new Error('Could not sign out.');
                                return `Signed out of ${account.label}.`;
                              }, 'Could not sign out.');
                            },
                          })
                        }
                      >
                        Sign out
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {provider.isCustom &&
          (editingConnection ? (
            <ProviderForm
              mode="edit"
              initial={{
                name: provider.label,
                ...presetDefaults(presets.find((preset) => preset.id === provider.id && !preset.builtinProviderId)),
              }}
              providerTypes={providerTypes}
              onCancel={() => setEditingConnection(false)}
              onSubmit={async (draft) => {
                const ok = await run(async () => {
                  const result = await term2Client.writeProvider({ action: 'save', originalId: provider.id, ...draft });
                  if (!result.ok) throw new Error(firstError(result) ?? 'The connection was not saved.');
                  return 'Connection saved.';
                }, 'The connection was not saved.');
                if (ok) setEditingConnection(false);
                return ok;
              }}
            />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <p className="font-medium text-foreground">Server and key</p>
                <p className="text-muted-foreground">
                  {provider.endpoint ? `${provider.endpoint.host}${provider.endpoint.path ?? ''} · ` : ''}
                  {provider.credential.source === 'local'
                    ? 'Local server, no key needed'
                    : provider.credential.configured
                      ? `API key ${credentialSourceText(provider.credential.source)}`
                      : 'No API key saved'}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditingConnection(true)}>
                Edit connection
              </Button>
            </div>
          ))}

        {!canEditKey && !isOAuth && !provider.isCustom && (
          <p className="text-sm text-muted-foreground">
            {provider.credential.configured
              ? `Credentials ${credentialSourceText(provider.credential.source)}.`
              : 'term2 cannot set up this provider from the web yet.'}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || modelsLoading || provider.disabled}
            onClick={testConnection}
          >
            {modelsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Test connection
          </Button>
          {provider.disabled && <span className="text-xs text-muted-foreground">Turn the provider on to test it.</span>}
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Documentation
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </SectionBlock>

      {!provider.disabled && models.length > 0 && (
        <SectionBlock title={`Models (${models.length})`}>
          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {visibleModels.map((model) => (
              <li key={model.id} className="truncate font-mono text-xs text-foreground" title={model.id}>
                {model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
              </li>
            ))}
          </ul>
          {models.length > 10 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-1 h-auto p-0"
              onClick={() => setShowAllModels((value) => !value)}
            >
              {showAllModels ? 'Show fewer' : `Show all ${models.length}`}
            </Button>
          )}
        </SectionBlock>
      )}

      {provider.isCustom ? (
        <SectionBlock title="Remove">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Delete this provider and its saved key from term2.</p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() =>
                onConfirm({
                  title: `Remove ${provider.label}`,
                  description: `term2 deletes the ${provider.label} provider and its saved key. Chats that use its models stop working until you add it again.`,
                  confirmLabel: 'Remove provider',
                  action: async () => {
                    const ok = await run(async () => {
                      const result = await term2Client.deleteProvider(provider.id);
                      if (!result.ok) throw new Error('The provider was not removed.');
                      return null;
                    }, 'The provider was not removed.');
                    if (ok) onRemoved();
                  },
                })
              }
            >
              Remove provider
            </Button>
          </div>
        </SectionBlock>
      ) : (
        <p className="border-t pt-4 text-xs text-muted-foreground">
          Built-in providers can&apos;t be removed. Turn it off to hide its models.
        </p>
      )}
    </div>
  );
}

function firstError(result: { error?: string; fieldErrors?: Record<string, string> }): string | undefined {
  return result.error ?? (result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined);
}

interface ProviderDraft {
  name: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
}

function presetDefaults(preset: ProviderPresetEntry | undefined): { type?: string; baseUrl?: string } {
  return preset ? { type: preset.type, baseUrl: preset.baseUrl } : {};
}

function ProviderForm({
  mode,
  initial,
  providerTypes,
  docsUrl,
  onCancel,
  onSubmit,
}: {
  mode: 'add' | 'edit';
  initial: { name?: string; type?: string; baseUrl?: string };
  providerTypes: string[];
  docsUrl?: string;
  onCancel: () => void;
  onSubmit: (draft: ProviderDraft) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [type, setType] = useState(initial.type ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const types = providerTypes.includes(type) ? providerTypes : [type, ...providerTypes];

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true);
        try {
          await onSubmit({
            name: name.trim(),
            type,
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          });
        } finally {
          setSaving(false);
        }
      }}
    >
      {mode === 'edit' && (
        <p className="text-sm text-muted-foreground">
          term2 doesn&apos;t show the saved address or key. Enter them again: saving replaces the server address, API
          format and key together.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">Name</span>
          <Input
            required
            value={name}
            readOnly={mode === 'edit'}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. my-server"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">API format</span>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((value) => (
                <SelectItem key={value} value={value}>
                  {TYPE_LABELS[value] ?? value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-foreground">Server address (base URL)</span>
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          inputMode="url"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-foreground">API key</span>
        <Input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Leave empty for local servers that need no key"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" size="sm" disabled={saving || !name.trim()}>
          {saving && <Loader2 className="animate-spin" />}
          {mode === 'add' ? 'Add provider' : 'Save connection'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Where to find a key
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </form>
  );
}

function AddProvider({
  presets,
  providerTypes,
  existingIds,
  onOpenExisting,
  onAdded,
}: {
  presets: ProviderPresetEntry[];
  providerTypes: string[];
  existingIds: Set<string>;
  onOpenExisting: (id: string) => void;
  onAdded: (before: Set<string>) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ProviderPresetEntry | 'custom' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = presets.filter(
      (preset) =>
        !needle ||
        preset.name.toLowerCase().includes(needle) ||
        preset.id.includes(needle) ||
        (CATEGORY_LABELS[preset.category] ?? preset.category).toLowerCase().includes(needle),
    );
    const byCategory = new Map<string, ProviderPresetEntry[]>();
    for (const preset of matching) byCategory.set(preset.category, [...(byCategory.get(preset.category) ?? []), preset]);
    return Object.keys(CATEGORY_LABELS)
      .concat([...byCategory.keys()].filter((key) => !(key in CATEGORY_LABELS)))
      .filter((key) => byCategory.has(key))
      .map((key) => ({ key, label: CATEGORY_LABELS[key] ?? key, presets: byCategory.get(key)! }));
  }, [presets, query]);

  if (chosen !== null) {
    const preset = chosen === 'custom' ? undefined : chosen;
    return (
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {preset ? `Add ${preset.name}` : 'Custom OpenAI-compatible server'}
        </h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">
          {preset?.category === 'local'
            ? 'The address is filled in from the preset. Local servers usually need no key.'
            : preset
            ? 'The address is filled in from the preset. Paste your API key to connect.'
            : 'Connect any server that speaks the OpenAI API, such as a local model runner or a company gateway.'}
        </p>
        {error && (
          <p role="alert" className="mb-3 flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </p>
        )}
        <ProviderForm
          mode="add"
          initial={{ name: preset?.id ?? '', ...presetDefaults(preset) }}
          providerTypes={providerTypes}
          docsUrl={preset?.docsUrl}
          onCancel={() => {
            setChosen(null);
            setError(null);
          }}
          onSubmit={async (draft) => {
            setError(null);
            try {
              const result = await term2Client.writeProvider({ action: 'save', ...draft });
              if (!result.ok) {
                setError(firstError(result) ?? 'The provider was not added.');
                return false;
              }
              await onAdded(existingIds);
              return true;
            } catch (reason) {
              setError(errorText(reason, 'The provider was not added.'));
              return false;
            }
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">Add a provider</h2>
      <p className="mt-1 text-sm text-muted-foreground">Pick a service, or connect your own server.</p>
      <div className="relative mt-4">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter providers"
          aria-label="Filter providers"
          className="pl-8"
        />
      </div>
      <button
        type="button"
        onClick={() => setChosen('custom')}
        className="mt-4 flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-left transition-colors hover:bg-muted"
      >
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span>
          <span className="block text-sm font-medium text-foreground">Custom OpenAI-compatible server</span>
          <span className="block text-xs text-muted-foreground">Any base URL, with or without a key.</span>
        </span>
      </button>
      {groups.map((group) => (
        <div key={group.key} className="mt-5">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.presets.map((preset) => {
              // Built-in services are already in the list; a preset already added opens that provider.
              const existing = preset.builtinProviderId ?? (existingIds.has(preset.id) ? preset.id : null);
              const added = existing !== null && !preset.builtinProviderId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => (existing !== null ? onOpenExisting(existing) : setChosen(preset))}
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="truncate font-medium text-foreground">{preset.name}</span>
                  {preset.builtinProviderId ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Built in</span>
                  ) : added ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Added</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No presets match.</p>}
    </div>
  );
}
