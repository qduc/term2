'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, ExternalLink, Loader2, Plus, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react';
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
import { SettingsConflictError, Term2ApiError, term2Client } from '../../lib/api/term2';
import { useTheme } from '../../contexts/ThemeContext';
import type { ModelSummary, ProviderPresetEntry, SettingsProjection } from '../../lib/term2/types';
import { REASONING_LEVELS } from './Term2ModelPicker';

type SettingsTab = 'providers' | 'models' | 'appearance' | 'limits' | 'advanced';

interface SettingMeta {
  label: string;
  description: string;
  kind: 'boolean' | 'number' | 'select' | 'text';
  options?: Array<{ value: string; label: string }>;
  unit?: string;
}

const SETTING_META: Record<string, SettingMeta> = {
  'agent.reasoningEffort': {
    label: 'Default reasoning effort',
    description: 'How deeply the model thinks before replying in new chats.',
    kind: 'select',
    options: REASONING_LEVELS.map((l) => ({ value: l.value, label: l.label })),
  },
  'agent.temperature': {
    label: 'Temperature',
    description: 'Sampling randomness (leave blank or reset to use the model default).',
    kind: 'number',
  },
  'app.liteMode': {
    label: 'Lite mode',
    description: 'Use a lighter prompt and smaller toolset for fast everyday chats.',
    kind: 'boolean',
  },
  'agent.contextCompaction.enabled': {
    label: 'Automatic context compaction',
    description: 'Summarize older conversation turns automatically before hitting the context limit.',
    kind: 'boolean',
  },
  'agent.contextCompaction.threshold': {
    label: 'Compaction threshold',
    description: 'Fraction of the context window (0.1–0.95) at which automatic compaction triggers.',
    kind: 'number',
  },
  'memory.enabled': {
    label: 'Personal memory',
    description: 'Allow Term2 to remember preferences and facts across conversations.',
    kind: 'boolean',
  },
  'webSearch.provider': {
    label: 'Web search provider',
    description: 'Search backend used when the assistant looks up live information online.',
    kind: 'select',
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'tavily', label: 'Tavily' },
      { value: 'exa', label: 'Exa' },
      { value: 'firecrawl', label: 'Firecrawl' },
      { value: 'searxng', label: 'SearXNG' },
      { value: 'none', label: 'Disabled' },
    ],
  },
  'webSearch.firecrawl.baseUrl': {
    label: 'Firecrawl base URL',
    description: 'Custom Firecrawl API endpoint (optional).',
    kind: 'text',
  },
  'webSearch.searxng.baseUrl': {
    label: 'SearXNG base URL',
    description: 'Self-hosted SearXNG instance URL.',
    kind: 'text',
  },
  'agent.maxTurns': {
    label: 'Max agent steps per turn',
    description: 'Pause and ask before continuing after this many tool rounds.',
    kind: 'number',
  },
  'agent.maxParallelToolCalls': {
    label: 'Max parallel tool calls',
    description: 'Maximum number of independent tools run simultaneously.',
    kind: 'number',
  },
  'agent.retryAttempts': {
    label: 'Model retry attempts',
    description: 'How many times to retry transient provider network errors.',
    kind: 'number',
  },
  'shell.autoApproveMode': {
    label: 'Default approval mode',
    description: 'Controls when Term2 asks for confirmation before running commands or editing files in new chats.',
    kind: 'select',
    options: [
      { value: 'off', label: 'Ask — prompt for every action' },
      { value: 'auto', label: 'Auto — auto-approve safe commands' },
      { value: 'unattended', label: 'Unattended — auto-approve safe & workspace actions' },
      { value: 'always', label: 'Always — auto-approve all tools' },
    ],
  },
  'shell.showReview': {
    label: 'Show approval review details',
    description: 'Show safety review rationale alongside automated approval decisions.',
    kind: 'boolean',
  },
  'shell.timeout': {
    label: 'Shell command timeout',
    description: 'Maximum duration before a shell command times out.',
    kind: 'number',
    unit: 'ms',
  },
  'shell.maxOutputLines': {
    label: 'Max shell output lines',
    description: 'Truncate shell output beyond this many lines.',
    kind: 'number',
  },
  'tools.maxOutputChars': {
    label: 'Max tool output characters',
    description: 'Character limit for tool output returned to the model.',
    kind: 'number',
  },
  'logging.logLevel': {
    label: 'Log level',
    description: 'Verbosity of local diagnostic logs.',
    kind: 'select',
    options: [
      { value: 'error', label: 'Error' },
      { value: 'warn', label: 'Warn' },
      { value: 'info', label: 'Info' },
      { value: 'debug', label: 'Debug' },
    ],
  },
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function Term2SettingsPanel({
  onLoaded,
  onProvidersChanged,
  preferredProvider,
  models = [],
  displayMode = 'concise',
  onDisplayModeChange,
  notificationsEnabled = false,
  onNotificationsChange,
  showDiagnostics = false,
  onShowDiagnosticsChange,
}: {
  onLoaded?: (settings: SettingsProjection) => void;
  onProvidersChanged?: () => void;
  preferredProvider?: string;
  models?: ModelSummary[];
  displayMode?: 'concise' | 'standard';
  onDisplayModeChange?: (mode: 'concise' | 'standard') => void;
  notificationsEnabled?: boolean;
  onNotificationsChange?: (enabled: boolean) => void;
  showDiagnostics?: boolean;
  onShowDiagnosticsChange?: (enabled: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<SettingsTab>('providers');
  const panelRef = useRef<HTMLElement>(null);
  // Each tab starts at its top; otherwise a long tab's scroll position carries into the next one.
  useEffect(() => {
    panelRef.current?.closest('.overflow-y-auto')?.scrollTo({ top: 0 });
  }, [tab]);
  const [projection, setProjection] = useState<SettingsProjection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<ProviderPresetEntry[]>([]);
  const [providerTypes, setProviderTypes] = useState<string[]>(['openai-compatible', 'anthropic', 'google', 'openai', 'llama.cpp']);
  const [addingProvider, setAddingProvider] = useState(false);
  const [presetQuery, setPresetQuery] = useState('');
  const [providerDraft, setProviderDraft] = useState({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '' });
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [advancedQuery, setAdvancedQuery] = useState('');
  const [confirm, setConfirm] = useState<{
    key: string;
    value: unknown;
    consequence: string;
  } | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const [conflict, setConflict] = useState<SettingsConflictError | null>(null);
  const [conflictKey, setConflictKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openConfirm = (pending: { key: string; value: unknown; consequence: string }) => {
    lastFocusedElementRef.current = (document.activeElement as HTMLElement) ?? null;
    setConfirm(pending);
  };

  const closeConfirm = () => setConfirm(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const latest = await term2Client.readSettings();
      setProjection(latest);
      onLoaded?.(latest);
      setConflict(null);
      setConflictKey(null);
    } catch (reason) {
      setError(
        reason instanceof Term2ApiError && reason.status === 503
          ? 'Local settings are not available in this deployment.'
          : reason instanceof Error
            ? reason.message
            : 'Unable to load settings',
      );
    } finally {
      setBusy(false);
    }
  }, [onLoaded]);

  useEffect(() => {
    void reload();
    void term2Client
      .listProviderPresets()
      .then((res) => {
        setPresets(res.presets);
        if (res.types.length > 0) setProviderTypes(res.types);
      })
      .catch(() => undefined);
  }, [reload]);

  const submit = async (key: string, value: unknown, revision = projection?.revision) => {
    if (!revision) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await term2Client.writeSettings({
        expectedRevision: revision,
        changes: [{ key, value }],
      });
      setProjection(result.projection);
      onLoaded?.(result.projection);
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setMessage(value === null ? 'Reset to built-in default.' : 'Setting saved.');
    } catch (reason) {
      if (reason instanceof SettingsConflictError) {
        setConflict(reason);
        setConflictKey(key);
      } else setError(reason instanceof Error ? reason.message : 'Setting was not saved; retry.');
    } finally {
      setBusy(false);
    }
  };

  const parseValue = (key: string, raw: string): unknown => {
    const meta = SETTING_META[key];
    if (meta?.kind === 'boolean') return raw === 'true';
    if (meta?.kind === 'number') {
      if (raw.trim() === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${meta.label} must be a valid number.`);
      return n;
    }
    return raw;
  };

  const requestChange = (key: string, value: unknown, confirmRequired: boolean) => {
    if (key === 'shell.autoApproveMode' && value === 'always') {
      openConfirm({
        key,
        value,
        consequence:
          'Enabling "Always" as the default approval mode will auto-approve all commands and file edits without prompting in future chats. Use only in trusted environments.',
      });
      return;
    }
    if (confirmRequired && value !== null) {
      openConfirm({
        key,
        value,
        consequence: `This changes ${SETTING_META[key]?.label ?? key} for future sessions. It may affect spend, duration, or tool activity.`,
      });
      return;
    }
    void submit(key, value);
  };

  const keepDraft = async () => {
    if (!conflict || Object.keys(drafts).length === 0) return;
    const key = conflictKey !== null && drafts[conflictKey] !== undefined ? conflictKey : Object.keys(drafts)[0];
    if (key === 'providers') return;
    const currentDraft = drafts[key];
    setProjection(conflict.projection);
    setConflict(null);
    setConflictKey(null);
    try {
      await submit(key, parseValue(key, currentDraft), conflict.currentRevision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid value');
    }
  };

  const filteredPresets = useMemo(() => {
    const needle = presetQuery.trim().toLowerCase();
    return presets.filter(
      (preset) =>
        !preset.builtinProviderId &&
        (!needle ||
          preset.name.toLowerCase().includes(needle) ||
          preset.id.toLowerCase().includes(needle) ||
          preset.category.toLowerCase().includes(needle)),
    );
  }, [presets, presetQuery]);

  if (!projection && busy) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings…
      </div>
    );
  }
  if (!projection) {
    return (
      <div className="space-y-2 text-sm">
        {error && (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="button" onClick={() => void reload()} variant="link" size="sm" className="h-auto p-0">
          Retry loading settings
        </Button>
      </div>
    );
  }

  const defaultModelValue = projection.settings.safeDefaults['agent.modelSelection']?.value as
    | { provider: string; model: string }
    | undefined;

  const renderSettingRow = (key: string) => {
    const setting = projection.settings.safeDefaults[key];
    if (!setting) return null;
    const meta = SETTING_META[key];
    const label = meta?.label ?? key;
    const isReadOnly = !setting.persistable;
    const rawCurrent = setting.value;

    if (meta?.kind === 'boolean') {
      const checked = rawCurrent === true;
      return (
        <div
          key={key}
          className="flex items-start justify-between gap-4 rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]"
        >
          <div className="min-w-0">
            <label htmlFor={`term2-setting-${key}`} className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {label}
            </label>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{meta.description}</p>
          </div>
          <input
            id={`term2-setting-${key}`}
            type="checkbox"
            checked={checked}
            disabled={busy || isReadOnly}
            onChange={(event) => requestChange(key, event.target.checked, setting.confirmRequired)}
            className="mt-1 h-4 w-4 shrink-0 accent-teal-600"
          />
        </div>
      );
    }

    if (meta?.kind === 'select' && meta.options) {
      const currentString = valueText(rawCurrent);
      return (
        <div
          key={key}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]"
        >
          <div className="min-w-0 flex-1">
            <label htmlFor={`term2-setting-${key}`} className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {label}
            </label>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{meta.description}</p>
          </div>
          <Select
            value={currentString}
            disabled={busy || isReadOnly}
            onValueChange={(value) => requestChange(key, value, setting.confirmRequired)}
          >
            <SelectTrigger id={`term2-setting-${key}`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!meta.options.some((o) => o.value === currentString) && currentString && (
                <SelectItem value={currentString}>{currentString}</SelectItem>
              )}
              {meta.options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    const draftVal = drafts[key] ?? valueText(rawCurrent);
    const dirty = drafts[key] !== undefined && drafts[key] !== valueText(rawCurrent);
    return (
      <div
        key={key}
        className="rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <label htmlFor={`term2-setting-${key}`} className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {label}
              {meta?.unit ? <span className="ml-1 text-xs font-normal text-zinc-400">({meta.unit})</span> : null}
            </label>
            {meta?.description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{meta.description}</p>}
          </div>
          {setting.source !== 'default' && !isReadOnly && (
            <Button
              type="button"
              disabled={busy}
              title={`Reset ${label} to default`}
              onClick={() => void submit(key, null)}
              variant="ghost" size="xs"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id={`term2-setting-${key}`}
            type={meta?.kind === 'number' ? 'number' : 'text'}
            step={key === 'agent.temperature' || key === 'agent.contextCompaction.threshold' ? '0.05' : undefined}
            value={draftVal}
            disabled={isReadOnly || busy}
            onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            disabled={busy || isReadOnly || !dirty}
            onClick={() => {
              try {
                const parsed = parseValue(key, draftVal);
                requestChange(key, parsed, setting.confirmRequired);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Invalid value');
              }
            }}
            size="sm"
          >
            Save
          </Button>
        </div>
      </div>
    );
  };

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'providers', label: 'Providers & Keys' },
    { id: 'models', label: 'Models' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'limits', label: 'Safety & Limits' },
    { id: 'advanced', label: 'Advanced' },
  ];

  const handleSaveProvider = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await term2Client.writeProvider({
        action: 'save',
        name: providerDraft.name.trim(),
        type: providerDraft.type,
        ...(providerDraft.baseUrl.trim() ? { baseUrl: providerDraft.baseUrl.trim() } : {}),
        ...(providerDraft.apiKey.trim() ? { apiKey: providerDraft.apiKey.trim() } : {}),
      });
      if (!res.ok) {
        const firstFieldErr = res.fieldErrors ? Object.values(res.fieldErrors)[0] : undefined;
        setError(res.error ?? firstFieldErr ?? 'Could not save provider.');
        return;
      }
      setMessage(`Provider “${providerDraft.name.trim()}” saved.`);
      setProviderDraft({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '' });
      setAddingProvider(false);
      await reload();
      onProvidersChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save provider.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={panelRef} aria-label="Term2 settings" className="space-y-4">
      <div
        className="sticky -top-4 z-10 -mx-5 -mt-4 flex flex-wrap gap-1 border-b border-black/[0.08] bg-popover px-5 pb-2 pt-4 sm:-top-5 sm:-mx-6 sm:-mt-5 sm:px-6 sm:pt-5 dark:border-white/10"
        role="tablist"
      >
        {tabs.map((item) => (
          <Button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            variant={tab === item.id ? 'default' : 'ghost'}
            size="sm"
          >
            {item.label}
          </Button>
        ))}
      </div>

      {message && (
        <p role="status" className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {conflict && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-semibold">Settings changed externally. Review before saving.</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" onClick={() => void reload()} variant="outline" size="xs">
              Reload latest
            </Button>
            <Button type="button" onClick={() => void keepDraft()} variant="outline" size="xs">
              Keep my change
            </Button>
            <Button type="button" onClick={() => setConflict(null)} variant="outline" size="xs">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {tab === 'providers' && (
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">AI providers &amp; API keys</h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Connect OpenAI, OpenRouter, Anthropic, Gemini, Ollama, or any OpenAI-compatible server. Keys stay on
                  your machine and are never sent in chat messages.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => setAddingProvider((v) => !v)}
                size="sm"
              >
                <Plus className="h-3.5 w-3.5" />
                Add provider
              </Button>
            </div>

            {addingProvider && (
              <div className="mt-3 space-y-3 rounded-xl border border-teal-500/30 bg-teal-500/[0.04] p-3.5 dark:border-teal-400/25">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Add a provider from a preset or custom URL
                  </h4>
                  <Button
                    type="button"
                    onClick={() => setAddingProvider(false)}
                    variant="link" size="xs"
                  >
                    Cancel
                  </Button>
                </div>

                {presets.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 dark:border-white/10 dark:bg-zinc-900">
                      <Search className="h-3.5 w-3.5 text-zinc-400" />
                      <input
                        value={presetQuery}
                        onChange={(e) => setPresetQuery(e.target.value)}
                        placeholder="Quick fill from preset (Anthropic, Gemini, DeepSeek, Ollama…)"
                        aria-label="Filter provider presets"
                        className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                      />
                    </div>
                    <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto scrollbar-thin">
                      {filteredPresets.map((preset) => (
                        <Button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            setProviderDraft((cur) => ({
                              ...cur,
                              name: preset.id,
                              type: preset.type ?? 'openai-compatible',
                              baseUrl: preset.baseUrl ?? '',
                            }))
                          }
                          variant="outline" size="xs" className="rounded-full"
                        >
                          <span>{preset.name}</span>
                          {preset.docsUrl && (
                            <a
                              href={preset.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Provider documentation"
                              className="text-zinc-400 hover:text-teal-600"
                            >
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                <form
                  className="grid gap-2.5 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSaveProvider();
                  }}
                >
                  <label className="text-xs">
                    <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Provider name</span>
                    <Input
                      required
                      autoComplete="username"
                      value={providerDraft.name}
                      onChange={(e) => setProviderDraft((c) => ({ ...c, name: e.target.value }))}
                      placeholder="e.g. anthropic, gemini, ollama"
                    />
                  </label>
                  <label className="text-xs">
                    <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">API format</span>
                    <Select
                      value={providerDraft.type}
                      onValueChange={(value) => setProviderDraft((c) => ({ ...c, type: value }))}
                    >
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providerTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-xs sm:col-span-2">
                    <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">Base URL</span>
                    <Input
                      value={providerDraft.baseUrl}
                      onChange={(e) => setProviderDraft((c) => ({ ...c, baseUrl: e.target.value }))}
                      placeholder="https://api.anthropic.com/v1"
                    />
                  </label>
                  <label className="text-xs sm:col-span-2">
                    <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                      API key (optional for local servers like Ollama)
                    </span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={providerDraft.apiKey}
                      onChange={(e) => setProviderDraft((c) => ({ ...c, apiKey: e.target.value }))}
                      placeholder="Paste API key…"
                    />
                  </label>
                  <div className="flex justify-end gap-2 sm:col-span-2">
                    <Button
                      type="submit"
                      disabled={busy || !providerDraft.name.trim()}
                      size="sm"
                    >
                      Save provider
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {projection.settings.providers.some((p) => p.isCustom) && (
              <div className="mt-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Custom providers
                </h4>
                <ul className="mt-1.5 space-y-1.5">
                  {projection.settings.providers
                    .filter((p) => p.isCustom)
                    .map((provider) => (
                      <li
                        key={provider.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-teal-500/25 bg-teal-500/[0.04] px-3 py-2 text-xs dark:border-teal-400/20 dark:bg-teal-500/[0.06]"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{provider.label}</span>
                          <span className="ml-1.5 font-mono text-xs text-zinc-400">({provider.id})</span>
                          {provider.id === preferredProvider && (
                            <span className="ml-1.5 rounded-full bg-teal-500/15 px-1.5 py-0.5 text-xs text-teal-700 dark:text-teal-300">
                              used by this chat
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await term2Client.writeProvider({
                                  action: 'toggle',
                                  id: provider.id,
                                  disabled: !provider.disabled,
                                });
                                await reload();
                                onProvidersChanged?.();
                              } finally {
                                setBusy(false);
                              }
                            }}
                            variant="outline" size="xs"
                          >
                            {provider.disabled ? 'Enable' : 'Disable'}
                          </Button>
                          <Button
                            type="button"
                            disabled={busy}
                            aria-label={`Delete ${provider.label}`}
                            onClick={() =>
                              openConfirm({
                                key: `provider-delete:${provider.id}`,
                                value: provider.id,
                                consequence: `Delete custom provider “${provider.label}” and its stored configuration?`,
                              })
                            }
                            variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <div className="mt-3 space-y-2">
              {Object.entries(projection.settings.credentials)
                .sort(([a], [b]) => Number(b === preferredProvider) - Number(a === preferredProvider))
                .map(([id, credential]) => {
                  const label =
                    projection.settings.providers.find((p) => p.id === id)?.label ??
                    (id === 'openai' ? 'OpenAI' : id.charAt(0).toUpperCase() + id.slice(1));
                  const isSearchKey = ['tavily', 'exa', 'firecrawl'].includes(id);
                  return (
                    <div
                      key={id}
                      className="rounded-xl border border-black/[0.08] p-3 dark:border-white/[0.08]"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {label}
                          {isSearchKey && <span className="ml-1.5 font-normal text-zinc-400">· web search</span>}
                          {id === preferredProvider && (
                            <span className="ml-1.5 rounded-full bg-teal-500/15 px-1.5 py-0.5 text-xs text-teal-700 dark:text-teal-300">
                              used by this chat
                            </span>
                          )}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            credential.configured
                              ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                          }`}
                        >
                          {credential.configured ? `Connected (${credential.source})` : 'Not set'}
                        </span>
                      </div>
                      <form
                        className="mt-2 flex gap-2"
                        noValidate
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (busy || !credential.writable || credential.source === 'environment' || !credentialDrafts[id]) {
                            return;
                          }
                          setBusy(true);
                          setError(null);
                          try {
                            await term2Client.setCredential(id, credentialDrafts[id]);
                            setMessage(`${label} API key saved.`);
                            setCredentialDrafts((c) => ({ ...c, [id]: '' }));
                            await reload();
                            onProvidersChanged?.();
                          } catch (reason) {
                            setError(reason instanceof Error ? reason.message : 'Credential was not saved');
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <input
                          type="text"
                          name="username"
                          value={id}
                          readOnly
                          autoComplete="username"
                          tabIndex={-1}
                          aria-hidden="true"
                          className="hidden"
                        />
                        <Input
                          type="password"
                          autoComplete="new-password"
                          aria-label={`${label} API key`}
                          value={credentialDrafts[id] ?? ''}
                          onChange={(e) => setCredentialDrafts((c) => ({ ...c, [id]: e.target.value }))}
                          disabled={!credential.writable || credential.source === 'environment'}
                          placeholder={
                            credential.source === 'environment'
                              ? 'Provided by environment variable'
                              : credential.configured
                                ? 'Paste a new key to replace…'
                                : `Paste your ${label} API key`
                          }
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="submit"
                          disabled={
                            busy || !credential.writable || credential.source === 'environment' || !credentialDrafts[id]
                          }
                          size="sm"
                        >
                          Save key
                        </Button>
                        {credential.configured && credential.writable && credential.source !== 'environment' && (
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              openConfirm({
                                key: `credential:${id}`,
                                value: '',
                                consequence: `Remove stored API key for ${label}?`,
                              })
                            }
                            variant="destructive" size="sm"
                          >
                            Remove
                          </Button>
                        )}
                      </form>
                    </div>
                  );
                })}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Browser sign-in accounts (OAuth)</h3>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Sign in with a ChatGPT Codex or Grok subscription instead of pasting an API key.
            </p>
            <div className="mt-2 space-y-2">
              {Object.entries(projection.settings.oauthAccounts).map(([provider, accounts]) => (
                <div
                  key={provider}
                  className="rounded-xl border border-black/[0.08] p-3 text-xs dark:border-white/[0.08]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize text-zinc-900 dark:text-zinc-100">{provider}</span>
                    <Button
                      type="button"
                      disabled={busy || oauthBusy !== null}
                      onClick={async () => {
                        setOauthBusy(provider);
                        setError(null);
                        setMessage(`Complete the ${provider} sign-in in the browser tab that opens…`);
                        try {
                          const result = await term2Client.oauthLogin(provider);
                          setMessage(
                            result.status === 'completed'
                              ? `Signed in to ${provider}.`
                              : `${provider} sign-in was not completed; try again.`,
                          );
                          await reload();
                          onProvidersChanged?.();
                        } catch (reason) {
                          setError(reason instanceof Error ? reason.message : 'OAuth login failed.');
                        } finally {
                          setOauthBusy(null);
                        }
                      }}
                      variant="outline" size="sm"
                    >
                      {oauthBusy === provider && <Loader2 className="h-3 w-3 animate-spin" />}
                      Sign in with {provider}
                    </Button>
                  </div>
                  {accounts.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-black/[0.05] pt-2 dark:border-white/[0.06]">
                      {accounts.map((account) => (
                        <li key={account.id} className="flex items-center justify-between py-0.5">
                          <span>
                            {account.label}{' '}
                            <span className="text-zinc-400">
                              {account.isSelected ? '· active' : ''}
                              {account.isInUse ? ' · in use' : ''}
                            </span>
                          </span>
                          <span className="flex gap-2">
                            {!account.isSelected && (
                              <Button
                                type="button"
                                onClick={async () => {
                                  await term2Client.oauthSelect(provider, account.id);
                                  await reload();
                                }}
                                variant="link" size="xs" className="h-auto p-0"
                              >
                                Use account
                              </Button>
                            )}
                            <Button
                              type="button"
                              onClick={async () => {
                                await term2Client.oauthDelete(provider, account.id);
                                await reload();
                                onProvidersChanged?.();
                              }}
                              variant="link" size="xs" className="h-auto p-0 text-destructive"
                            >
                              Sign out
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'models' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]">
            <label htmlFor="term2-default-model" className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Default model for new chats
            </label>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Current default:{' '}
              <code className="font-mono">
                {defaultModelValue ? `${defaultModelValue.provider}/${defaultModelValue.model}` : 'not set'}
              </code>
            </p>
            {models.length > 0 ? (
              <Select
                disabled={busy}
                value={defaultModelValue ? `${defaultModelValue.provider}/${defaultModelValue.model}` : ''}
                onValueChange={(raw) => {
                  const slash = raw.indexOf('/');
                  if (slash <= 0) return;
                  void submit('agent.modelSelection', {
                    provider: raw.slice(0, slash),
                    model: raw.slice(slash + 1),
                  });
                }}
              >
                <SelectTrigger id="term2-default-model" className="mt-2 w-full font-mono">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  {defaultModelValue &&
                    !models.some(
                      (m) => m.provider === defaultModelValue.provider && m.id === defaultModelValue.model,
                    ) && (
                      <SelectItem value={`${defaultModelValue.provider}/${defaultModelValue.model}`}>
                        {defaultModelValue.provider}/{defaultModelValue.model}
                      </SelectItem>
                    )}
                  {models.map((m) => (
                    <SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`} className="font-mono">
                      {m.provider} / {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                Connect a provider in the Providers &amp; Keys tab to choose from its models.
              </p>
            )}
          </div>
          {renderSettingRow('agent.reasoningEffort')}
          {renderSettingRow('agent.temperature')}
          {renderSettingRow('app.liteMode')}
        </div>
      )}

      {tab === 'appearance' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]">
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Color theme</h3>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Match your operating system or pick light or dark mode.
            </p>
            <div className="mt-2.5 flex gap-2">
              {(['system', 'light', 'dark'] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  onClick={() => setTheme(mode)}
                  variant={theme === mode ? 'default' : 'outline'}
                  size="sm"
                  className="capitalize"
                >
                  {mode}
                </Button>
              ))}
            </div>
          </div>

          {onShowDiagnosticsChange && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]">
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Diagnostics</h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Show raw session state under the transcript. Off until you turn it on.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showDiagnostics}
                aria-label="Show diagnostics"
                onClick={() => onShowDiagnosticsChange(!showDiagnostics)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  showDiagnostics ? 'bg-teal-600' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                    showDiagnostics ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          )}

          {onDisplayModeChange && (
            <div className="rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]">
              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Tool activity display</h3>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Concise folds each run of tool calls into one line and hides finished reasoning. Standard shows one
                row per tool call. Click any row to see its full input and output.
              </p>
              <div className="mt-2.5 flex gap-2">
                {(['standard', 'concise'] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    onClick={() => onDisplayModeChange(mode)}
                    variant={displayMode === mode ? 'default' : 'outline'}
                    size="sm"
                    className="capitalize"
                  >
                    {mode}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {onNotificationsChange && (
            <div className="flex items-start justify-between gap-4 rounded-xl border border-black/[0.07] p-3 dark:border-white/[0.08]">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  <Bell className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  Browser notifications
                </h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Notify you when this tab is in the background and Term2 needs an approval or finishes a reply.
                </p>
              </div>
              <input
                type="checkbox"
                aria-label="Enable browser notifications"
                checked={notificationsEnabled}
                onChange={(event) => {
                  const next = event.target.checked;
                  if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                    void Notification.requestPermission();
                  }
                  onNotificationsChange(next);
                }}
                className="mt-1 h-4 w-4 shrink-0 accent-teal-600"
              />
            </div>
          )}
        </div>
      )}

      {tab === 'limits' && (
        <div className="space-y-3">
          {renderSettingRow('shell.autoApproveMode')}
          {renderSettingRow('shell.showReview')}
          {renderSettingRow('agent.contextCompaction.enabled')}
          {renderSettingRow('agent.contextCompaction.threshold')}
          {renderSettingRow('memory.enabled')}
          {renderSettingRow('webSearch.provider')}
          {renderSettingRow('agent.maxTurns')}
          {renderSettingRow('agent.maxParallelToolCalls')}
          {renderSettingRow('shell.timeout')}
          <div className="rounded-xl border border-black/[0.08] bg-zinc-50/70 p-3.5 text-xs dark:border-white/[0.08] dark:bg-white/[0.02]">
            <h3 className="flex items-center gap-1.5 font-semibold text-zinc-900 dark:text-zinc-100">
              <ShieldCheck className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              Safety &amp; gateway permissions
            </h3>
            <p className="mt-1 text-zinc-500 dark:text-zinc-400">
              These guardrails are enforced by the local gateway process. You can also override the approval mode per
              chat from the composer toolbar.
            </p>
            <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-zinc-600 dark:text-zinc-400">
              <dt>Default approval mode</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-200">
                {(() => {
                  const configured = String(projection.settings.safeDefaults['shell.autoApproveMode']?.value ?? 'off');
                  if (configured === 'auto') return 'Auto (safe commands)';
                  if (configured === 'unattended') return 'Unattended';
                  if (configured === 'always') return 'Always (auto-approve all)';
                  return 'Ask before running tools';
                })()}
              </dd>
              <dt>Folder access</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-200">
                {projection.settings.safety.workspaceAccess === 'read_write' ? 'Read & write enabled' : 'Read only'}
              </dd>
              <dt>Sandbox</dt>
              <dd className="font-medium capitalize text-zinc-900 dark:text-zinc-200">
                {projection.settings.safety.sandbox}
              </dd>
              <dt>Sandbox network</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-200">{projection.settings.safety.network}</dd>
            </dl>
          </div>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/10">
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <input
              type="search"
              value={advancedQuery}
              onChange={(e) => setAdvancedQuery(e.target.value)}
              placeholder="Search all settings…"
              aria-label="Search settings"
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </label>
          <div className="space-y-2">
            {Object.keys(projection.settings.safeDefaults)
              .filter(
                (key) =>
                  key !== 'agent.modelSelection' &&
                  key !== 'agent.favoriteModels' &&
                  (!advancedQuery.trim() ||
                    key.toLowerCase().includes(advancedQuery.trim().toLowerCase()) ||
                    (SETTING_META[key]?.label ?? '').toLowerCase().includes(advancedQuery.trim().toLowerCase())),
              )
              .map((key) => renderSettingRow(key))}
          </div>
        </div>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // No AlertDialogTrigger: return focus to the control that asked for confirmation.
            event.preventDefault();
            if (lastFocusedElementRef.current?.isConnected) lastFocusedElementRef.current.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.key.startsWith('credential:')
                ? 'Remove API key'
                : confirm?.key.startsWith('provider-delete:')
                  ? 'Delete provider'
                  : 'Confirm setting change'}
            </AlertDialogTitle>
            <AlertDialogDescription>{confirm?.consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const pending = confirm;
                if (!pending) return;
                closeConfirm();
                if (pending.key.startsWith('credential:')) {
                  const credId = pending.key.slice('credential:'.length);
                  setBusy(true);
                  try {
                    await term2Client.deleteCredential(credId);
                    setMessage('API key removed.');
                    await reload();
                    onProvidersChanged?.();
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : 'Credential was not deleted');
                  } finally {
                    setBusy(false);
                  }
                } else if (pending.key.startsWith('provider-delete:')) {
                  const providerId = String(pending.value);
                  setBusy(true);
                  try {
                    await term2Client.deleteProvider(providerId);
                    setMessage('Custom provider deleted.');
                    await reload();
                    onProvidersChanged?.();
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : 'Provider was not deleted');
                  } finally {
                    setBusy(false);
                  }
                } else {
                  void submit(pending.key, pending.value);
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
