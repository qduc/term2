'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, Search } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTheme } from '../../../contexts/ThemeContext';
import { SettingsConflictError, Term2ApiError, term2Client } from '../../../lib/api/term2';
import type { ModelSummary, ProviderPresetEntry, SettingsProjection } from '../../../lib/term2/types';
import { CredentialField } from './CredentialField';
import { ProvidersSection } from './ProvidersSection';
import { NumberField, SettingRow, controlId, type CommitResult, type RowStatus } from './SettingRow';
import {
  LOCAL_DEFAULTS,
  SECTION_KEYWORDS,
  SETTINGS_SECTIONS,
  differsFromDefault,
  itemKeys,
  matchesQuery,
  sectionLabel,
  textMatches,
  visibleItems,
  type SettingItem,
  type SettingsSectionId,
} from './settings-catalog';

type DisplayMode = 'concise' | 'standard';
type Change = { key: string; value: unknown };

const SECTION_DESCRIPTIONS: Record<SettingsSectionId, string> = {
  providers: 'The AI services term2 can use. Keys stay on this machine and are never sent in chat.',
  safety: 'When term2 asks before acting, and what the local gateway enforces.',
  conversation: 'Memory and how long conversations are kept within the model’s context.',
  'web-search': 'How the assistant looks things up online.',
  appearance: 'How the web app looks and behaves. Saved in this browser.',
  advanced: 'Limits that stop runaway work, and diagnostics. Most people never change these.',
};

/** A model request limit needs a value when "No limit" is turned off; ten minutes is a safe start. */
const DEFAULT_REQUEST_LIMIT_MS = 600_000;

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  action: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
    element.getAttribute('role') === 'combobox'
  );
}

function providerKeywords(
  provider: SettingsProjection['settings']['providers'][number],
  isOAuth: boolean,
): string[] {
  return [
    provider.label,
    provider.id,
    ...(isOAuth ? ['sign in', 'login', 'log in', 'account', 'subscription'] : ['api key', 'key', 'token']),
    ...(provider.isCustom ? ['custom', 'server', 'base url', 'local'] : []),
  ];
}

/**
 * The full-page settings view. It replaces the chat while open; the section and provider live in
 * the URL (`?settings=<section>&provider=<id>`), so Back and refresh return to the same place.
 */
export function Term2SettingsPage({
  section,
  provider,
  onNavigate,
  onClose,
  onLoaded,
  models,
  modelsLoading,
  onModelsChanged,
  displayMode,
  onDisplayModeChange,
  notificationsEnabled,
  onNotificationsChange,
  showDiagnostics,
  onShowDiagnosticsChange,
}: {
  section: SettingsSectionId;
  provider: string | null;
  onNavigate: (section: SettingsSectionId, provider?: string | null) => void;
  onClose: () => void;
  onLoaded?: (settings: SettingsProjection) => void;
  models: ModelSummary[];
  modelsLoading: boolean;
  onModelsChanged: () => Promise<void>;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  notificationsEnabled: boolean;
  onNotificationsChange: (enabled: boolean) => void;
  showDiagnostics: boolean;
  onShowDiagnosticsChange: (enabled: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const [projection, setProjection] = useState<SettingsProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presets, setPresets] = useState<ProviderPresetEntry[]>([]);
  const [providerTypes, setProviderTypes] = useState<string[]>([
    'openai-compatible',
    'anthropic',
    'google',
    'openai',
    'llama.cpp',
  ]);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [modelsChecked, setModelsChecked] = useState(false);
  const searchRefs = useRef<Array<HTMLInputElement | null>>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const applyProjection = useCallback(
    (next: SettingsProjection) => {
      setProjection(next);
      onLoaded?.(next);
    },
    [onLoaded],
  );

  const reload = useCallback(async (): Promise<SettingsProjection | null> => {
    setLoadError(null);
    try {
      const latest = await term2Client.readSettings();
      applyProjection(latest);
      return latest;
    } catch (reason) {
      setLoadError(
        reason instanceof Term2ApiError && reason.status === 503
          ? 'Local settings are not available in this deployment.'
          : reason instanceof Error && reason.message
            ? reason.message
            : 'Settings could not be loaded.',
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyProjection]);

  useEffect(() => {
    void reload();
    void term2Client
      .listProviderPresets()
      .then((result) => {
        setPresets(result.presets);
        if (result.types.length > 0) setProviderTypes(result.types);
      })
      .catch(() => undefined);
    // A fresh model list makes each provider's status line current.
    void onModelsChanged().finally(() => setModelsChecked(true));
    // Runs once per opening of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timers = savedTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  // Each section starts at its top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section, provider]);

  const focusSearch = useCallback(() => {
    const visible = searchRefs.current.find((input) => input && input.offsetParent !== null);
    visible?.focus();
    visible?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
      const isPalette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (isPalette || (event.key === '/' && !event.metaKey && !event.ctrlKey && !isEditable(event.target))) {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusSearch]);

  const setStatus = (id: string, status: RowStatus | null) => {
    clearTimeout(savedTimers.current[id]);
    setRowStatus((current) => {
      const next = { ...current };
      if (status) next[id] = status;
      else delete next[id];
      return next;
    });
    if (status?.state === 'saved') savedTimers.current[id] = setTimeout(() => setStatus(id, null), 2000);
  };

  const items = useMemo(() => (projection ? visibleItems(projection) : []), [projection]);
  const stored = (key: string): unknown => projection?.settings.safeDefaults[key]?.value;

  const localValue = (id: string): unknown => {
    switch (id) {
      case 'local:theme':
        return theme;
      case 'local:displayMode':
        return displayMode;
      case 'local:notifications':
        return notificationsEnabled;
      case 'local:diagnostics':
        return showDiagnostics;
      default:
        return undefined;
    }
  };

  const isModified = (item: SettingItem): boolean => {
    if (item.source === 'local') return localValue(item.id) !== LOCAL_DEFAULTS[item.id];
    return itemKeys(item).some((key) => differsFromDefault(key, stored(key)));
  };

  const lockedReason = (item: SettingItem): string | undefined => {
    const sources = itemKeys(item).map((key) => projection?.settings.safeDefaults[key]?.source);
    if (sources.includes('environment')) return 'Set by an environment variable, so it can’t be changed here.';
    if (sources.includes('cli')) return 'Set by a command-line option when term2 started, so it can’t be changed here.';
    return undefined;
  };

  const modifiedCounts = useMemo(() => {
    const counts: Partial<Record<SettingsSectionId, number>> = {};
    for (const item of items) if (isModified(item)) counts[item.section] = (counts[item.section] ?? 0) + 1;
    return counts;
    // isModified reads the same inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, theme, displayMode, notificationsEnabled, showDiagnostics]);

  /** Saves one row's keys in a single settings write. */
  const saveServer = async (statusId: string, changes: Change[]) => {
    const revision = projection?.revision;
    if (!revision) return;
    setStatus(statusId, { state: 'saving' });
    try {
      const result = await term2Client.writeSettings({ expectedRevision: revision, changes });
      applyProjection(result.projection);
      setStatus(statusId, { state: 'saved' });
    } catch (reason) {
      if (reason instanceof SettingsConflictError) {
        applyProjection(reason.projection);
        setStatus(statusId, {
          state: 'error',
          message: 'Settings changed somewhere else. The latest values are shown; make your change again.',
        });
      } else {
        setStatus(statusId, {
          state: 'error',
          message:
            reason instanceof Term2ApiError && reason.status === 400
              ? 'Not saved: term2 doesn’t accept that value.'
              : reason instanceof Error && reason.message
                ? `Not saved: ${reason.message}`
                : 'Not saved. Try again.',
        });
      }
    }
  };

  /** Saves a server change, first asking when the gateway marks the key as needing confirmation. */
  const requestServer = (item: SettingItem, changes: Change[]): CommitResult => {
    const setting = projection?.settings.safeDefaults[changes[0]?.key ?? ''];
    if (!setting) return;
    if (changes.some((change) => change.key === 'shell.autoApproveMode' && change.value === 'always')) {
      setConfirm({
        title: 'Approve everything by default?',
        description: 'New chats will run every command and file edit without asking. Use this only in trusted folders.',
        confirmLabel: 'Approve everything',
        destructive: true,
        action: () => void saveServer(item.id, changes),
      });
      return 'confirming';
    }
    if (changes.some((change) => change.value !== null && projection?.settings.safeDefaults[change.key]?.confirmRequired)) {
      setConfirm({
        title: `Change ${item.label.toLowerCase()}?`,
        description: 'This applies to future chats and can change how long they run, what they cost, or what tools do.',
        confirmLabel: 'Change setting',
        action: () => void saveServer(item.id, changes),
      });
      return 'confirming';
    }
    void saveServer(item.id, changes);
    return 'saving';
  };

  const commit = (item: SettingItem, value: unknown): CommitResult => {
    if (item.source === 'local') {
      if (item.id === 'local:theme') setTheme(value as 'system' | 'light' | 'dark');
      else if (item.id === 'local:displayMode') onDisplayModeChange(value as DisplayMode);
      else if (item.id === 'local:notifications') {
        if (value === true && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          void Notification.requestPermission();
        }
        onNotificationsChange(value === true);
      } else if (item.id === 'local:diagnostics') onShowDiagnosticsChange(value === true);
      setStatus(item.id, { state: 'saved' });
      return 'saving';
    }
    return requestServer(item, [{ key: item.id, value }]);
  };

  const reset = (item: SettingItem) => {
    if (item.source === 'local') commit(item, LOCAL_DEFAULTS[item.id]);
    else void saveServer(item.id, itemKeys(item).map((key) => ({ key, value: null })));
  };

  const credentialControl = (item: SettingItem) => {
    const id = item.id.slice('credential:'.length);
    const credential = projection?.settings.credentials[id];
    if (!credential) return null;
    return (
      <CredentialField
        id={id}
        label={item.label}
        credential={credential}
        onSave={async (value) => {
          setStatus(item.id, { state: 'saving' });
          try {
            await term2Client.setCredential(id, value);
            await reload();
            setStatus(item.id, { state: 'saved' });
            return true;
          } catch (reason) {
            setStatus(item.id, {
              state: 'error',
              message: reason instanceof Error && reason.message ? `Not saved: ${reason.message}` : 'Not saved.',
            });
            return false;
          }
        }}
        onRemove={() =>
          setConfirm({
            title: `Remove ${item.label}?`,
            description: 'term2 forgets the saved key. Web search with this service stops until you add it again.',
            confirmLabel: 'Remove key',
            destructive: true,
            action: () =>
              void (async () => {
                setStatus(item.id, { state: 'saving' });
                try {
                  await term2Client.deleteCredential(id);
                  await reload();
                  setStatus(item.id, { state: 'saved' });
                } catch (reason) {
                  setStatus(item.id, {
                    state: 'error',
                    message: reason instanceof Error && reason.message ? reason.message : 'The key was not removed.',
                  });
                }
              })(),
          })
        }
      />
    );
  };

  /** One switch, and when it is on, the share of the context window at which compaction starts. */
  const compactionControl = (item: SettingItem) => {
    const [enabledKey] = itemKeys(item);
    const saving = rowStatus[item.id]?.state === 'saving';
    return (
      <Switch
        id={controlId(item.id)}
        aria-label={item.label}
        checked={stored(enabledKey) === true}
        disabled={Boolean(lockedReason(item)) || saving}
        onCheckedChange={(checked) => requestServer(item, [{ key: enabledKey, value: checked }])}
      />
    );
  };

  const compactionThreshold = (item: SettingItem) => {
    const [enabledKey, thresholdKey] = itemKeys(item);
    if (stored(enabledKey) !== true) return undefined;
    const saving = rowStatus[item.id]?.state === 'saving';
    const locked = Boolean(lockedReason(item));
    return (
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span>Compact when the context is</span>
            <NumberField
              id={controlId(thresholdKey)}
              label="Compaction threshold in percent"
              value={stored(thresholdKey)}
              factor={item.factor}
              unit={item.unit}
              min={item.min}
              max={item.max}
              step={item.step}
              disabled={locked || saving}
              saving={saving}
              onCommit={(value) => requestServer(item, [{ key: thresholdKey, value }])}
            />
          </div>
    );
  };

  /** A "No limit" switch (stored as 0) and, when limited, the limit in seconds. */
  const durationLimitControl = (item: SettingItem) => {
    const [key] = itemKeys(item);
    const value = stored(key);
    const unlimited = value === 0 || value === undefined || value === null;
    const saving = rowStatus[item.id]?.state === 'saving';
    const locked = Boolean(lockedReason(item));
    return (
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          No limit
          <Switch
            checked={unlimited}
            disabled={locked || saving}
            onCheckedChange={(checked) =>
              requestServer(item, [{ key, value: checked ? 0 : DEFAULT_REQUEST_LIMIT_MS }])
            }
          />
        </label>
        {!unlimited && (
          <NumberField
            id={controlId(item.id)}
            label={`${item.label} in ${item.unit}`}
            value={value}
            factor={item.factor}
            unit={item.unit}
            min={item.min}
            disabled={locked || saving}
            saving={saving}
            onCommit={(next) => requestServer(item, [{ key, value: next }])}
          />
        )}
      </div>
    );
  };

  const safetySummary = (breadcrumb?: string) => {
    if (!projection) return null;
    const safety = projection.settings.safety;
    // Read-only folders always run shell in the sandbox, or get no shell when it can't run (contract 13);
    // `sandbox.enabled` governs only read & write folders.
    const sandboxLine =
      projection.shellSandboxNotice || safety.sandbox === 'unavailable'
        ? 'The sandbox isn’t available on this machine, so read-only folders get no shell commands.'
        : safety.sandbox === 'enabled'
          ? 'Shell commands run in the sandbox.'
          : 'In read & write folders, shell commands run unconfined because the sandbox is turned off. Read-only folders still use the sandbox.';
    const networkLine =
      safety.network === 'denied'
        ? 'Sandboxed commands can’t reach the network.'
        : safety.network === 'confirmation-required'
          ? 'Sandboxed commands can use the network after you confirm.'
          : 'Sandboxed network access follows your term2 configuration.';
    return (
      <div key="info:sandbox" className="py-4">
        {breadcrumb && <p className="mb-0.5 text-xs text-muted-foreground">{breadcrumb}</p>}
        <h3 className="text-sm font-medium text-foreground">Sandbox and network</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Set by the local gateway when term2 starts; it can’t be changed here.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>{sandboxLine}</li>
          <li>{networkLine}</li>
          {safety.backgroundShell === 'disabled-by-gateway' && (
            <li>Background shell commands are turned off in the web app.</li>
          )}
          <li>
            Read or write access is set per folder. Change it from a folder’s ⋯ menu in the sidebar, or when you
            choose a folder.
          </li>
        </ul>
      </div>
    );
  };

  const renderItem = (item: SettingItem, breadcrumb?: string) => {
    if (item.kind === 'info') return safetySummary(breadcrumb);
    const control =
      item.kind === 'credential'
        ? credentialControl(item)
        : item.kind === 'compaction'
          ? compactionControl(item)
          : item.kind === 'duration-limit'
            ? durationLimitControl(item)
            : undefined;
    return (
      <SettingRow
        key={item.id}
        item={item}
        breadcrumb={breadcrumb}
        value={item.source === 'local' ? localValue(item.id) : stored(item.id)}
        modified={isModified(item)}
        lockedReason={lockedReason(item)}
        status={rowStatus[item.id]}
        onCommit={(value) => commit(item, value)}
        onReset={() => reset(item)}
        control={control}
        below={item.kind === 'compaction' ? compactionThreshold(item) : undefined}
      />
    );
  };

  const needle = query.trim().toLowerCase();
  const searchResults = needle ? items.filter((item) => matchesQuery(item, needle)) : [];
  const providerResults =
    needle && projection
      ? projection.settings.providers.filter((entry) =>
          textMatches(providerKeywords(entry, entry.id in projection.settings.oauthAccounts), needle),
        )
      : [];
  const sectionResults = needle
    ? SETTINGS_SECTIONS.filter((entry) => textMatches([entry.label, ...SECTION_KEYWORDS[entry.id]], needle))
    : [];
  const resultCount = searchResults.length + providerResults.length + sectionResults.length;

  const searchBox = (index: number) => (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={(element) => {
          searchRefs.current[index] = element;
        }}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setQuery('');
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="pl-8"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border px-1 text-[10px] text-muted-foreground md:block">
        /
      </kbd>
    </div>
  );

  const linkRow = (key: string, crumb: string, title: string, detail: string, onOpen: () => void) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        setQuery('');
        onOpen();
      }}
      className="flex w-full items-center justify-between gap-4 py-4 text-left"
    >
      <span>
        <span className="block text-xs text-muted-foreground">{crumb}</span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-sm text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );

  let body: React.ReactNode;
  if (!projection) {
    body = loading ? (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading settings…
      </p>
    ) : (
      <div className="space-y-2 text-sm">
        <p role="alert" className="text-destructive">
          {loadError ?? 'Settings could not be loaded.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  } else if (needle) {
    body = (
      <div>
        <h2 className="text-lg font-semibold text-foreground">Search results</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {resultCount === 0
            ? `Nothing matches “${query.trim()}”.`
            : `${resultCount} result${resultCount === 1 ? '' : 's'} for “${query.trim()}”.`}
        </p>
        <div className="mt-2 divide-y">
          {sectionResults.map((entry) =>
            linkRow(`section:${entry.id}`, 'Section', entry.label, SECTION_DESCRIPTIONS[entry.id], () =>
              onNavigate(entry.id),
            ),
          )}
          {providerResults.map((entry) =>
            linkRow(
              `provider:${entry.id}`,
              'Providers',
              entry.label,
              `${entry.disabled ? 'Off' : entry.credential.configured ? 'Connected' : 'Not set up'} · open its connection settings`,
              () => onNavigate('providers', entry.id),
            ),
          )}
          {searchResults.map((item) =>
            renderItem(item, [sectionLabel(item.section), item.group, item.label].filter(Boolean).join(' › ')),
          )}
        </div>
      </div>
    );
  } else if (section === 'providers') {
    body = (
      <ProvidersSection
        projection={projection}
        models={models}
        modelsLoading={modelsLoading}
        modelsChecked={modelsChecked}
        presets={presets}
        providerTypes={providerTypes}
        routeProvider={provider}
        onNavigate={(id) => onNavigate('providers', id)}
        onReload={reload}
        onModelsChanged={onModelsChanged}
      />
    );
  } else {
    const sectionItems = items.filter((item) => item.section === section);
    const groups: Array<{ name?: string; items: SettingItem[] }> = [];
    for (const item of sectionItems) {
      const last = groups.at(-1);
      if (last && last.name === item.group) last.items.push(item);
      else groups.push({ name: item.group, items: [item] });
    }
    body = (
      <div>
        {groups.map((group, index) => (
          <Fragment key={group.name ?? index}>
            {group.name && (
              <h3 className={cn('text-xs font-medium uppercase tracking-wide text-muted-foreground', index > 0 ? 'mt-8' : 'mt-6')}>
                {group.name}
              </h3>
            )}
            <div className="divide-y">{group.items.map((item) => renderItem(item))}</div>
          </Fragment>
        ))}
      </div>
    );
  }

  const heading = needle ? null : (
    <div className="mb-2">
      <h2 className="text-xl font-semibold text-foreground">{sectionLabel(section)}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{SECTION_DESCRIPTIONS[section]}</p>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft />
          Back to chat
        </Button>
        <span aria-hidden className="h-4 w-px bg-border" />
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="hidden w-60 shrink-0 flex-col gap-3 border-r p-3 md:flex">
          {searchBox(0)}
          <ul className="space-y-0.5">
            {SETTINGS_SECTIONS.map((entry) => {
              const active = !needle && entry.id === section;
              const count = modifiedCounts[entry.id] ?? 0;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setQuery('');
                      onNavigate(entry.id);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                      active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {entry.label}
                    {count > 0 && (
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">{count} modified</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="space-y-2 border-b p-3 md:hidden">
            {searchBox(1)}
            <Select
              value={section}
              onValueChange={(value) => {
                setQuery('');
                onNavigate(value as SettingsSectionId);
              }}
            >
              <SelectTrigger aria-label="Settings section" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SETTINGS_SECTIONS.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                    {(modifiedCounts[entry.id] ?? 0) > 0 ? ` · ${modifiedCounts[entry.id]} modified` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div
            className={cn(
              'mx-auto px-4 py-6 sm:px-6',
              section === 'providers' && !needle ? 'max-w-5xl' : 'max-w-[720px]',
            )}
          >
            {heading}
            {body}
          </div>
        </div>
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
              variant={confirm?.destructive ? 'destructive' : 'default'}
              onClick={() => {
                const pending = confirm;
                setConfirm(null);
                pending?.action();
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
