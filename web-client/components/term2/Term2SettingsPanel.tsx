'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsConflictError, Term2ApiError, term2Client } from '../../lib/api/term2';
import type { SettingsProjection } from '../../lib/term2/types';

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function Term2SettingsPanel() {
  const [projection, setProjection] = useState<SettingsProjection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{
    key: string;
    value: string;
    consequence: string;
  } | null>(null);
  const confirmCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const [conflict, setConflict] = useState<SettingsConflictError | null>(null);
  const [conflictKey, setConflictKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openConfirm = (pending: { key: string; value: string; consequence: string }) => {
    lastFocusedElementRef.current = (document.activeElement as HTMLElement) ?? null;
    setConfirm(pending);
  };

  const closeConfirm = () => {
    setConfirm(null);
    if (lastFocusedElementRef.current && typeof lastFocusedElementRef.current.focus === 'function') {
      lastFocusedElementRef.current.focus();
    }
  };

  useEffect(() => {
    if (confirm) {
      confirmCancelButtonRef.current?.focus();
    }
  }, [confirm]);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setProjection(await term2Client.readSettings());
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
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const submit = async (key: string, value: string, revision = projection?.revision) => {
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
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setMessage('Setting saved for future sessions.');
    } catch (reason) {
      if (reason instanceof SettingsConflictError) {
        setConflict(reason);
        setConflictKey(key);
      } else setError(reason instanceof Error ? reason.message : 'Setting was not saved; retry.');
    } finally {
      setBusy(false);
    }
  };
  const requestChange = (key: string, value: string, confirmRequired: boolean) => {
    if (confirmRequired) {
      openConfirm({
        key,
        value,
        consequence: `This changes ${key} for future sessions. It may change approval, spend, duration, or tool activity.`,
      });
      return;
    }
    void submit(key, value);
  };
  const keepDraft = async () => {
    if (!conflict || Object.keys(drafts).length === 0) return;
    // Re-submit the key that actually conflicted, not just the first dirty
    // draft (a stale draft from an earlier failed save must not hijack
    // conflict recovery).
    const key = conflictKey !== null && drafts[conflictKey] !== undefined ? conflictKey : Object.keys(drafts)[0];
    if (key === 'providers') return;
    const currentDraft = drafts[key];
    setProjection(conflict.projection);
    setConflict(null);
    setConflictKey(null);
    await submit(key, currentDraft, conflict.currentRevision);
  };

  if (!projection && busy)
    return (
      <section aria-label="Term2 settings" className="rounded-xl border border-zinc-200 p-4">
        Loading local settings…
      </section>
    );
  if (!projection)
    return (
      <section aria-label="Term2 settings" className="rounded-xl border border-zinc-200 p-4">
        <h2 className="font-semibold">Local settings</h2>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button type="button" onClick={() => void reload()} className="mt-3 text-sm underline">
          Retry
        </button>
      </section>
    );

  return (
    <section
      aria-labelledby="term2-settings-heading"
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between">
        <h2 id="term2-settings-heading" className="font-semibold">
          Local settings and providers
        </h2>
        <button type="button" onClick={() => void reload()} disabled={busy} className="text-xs underline">
          Reload
        </button>
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm text-emerald-700">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {conflict && (
        <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p>
            <strong>Settings changed externally.</strong> Review your draft before saving.
          </p>
          <div className="mt-2 space-y-1 text-xs">
            {Object.entries(drafts).map(([key, draft]) => (
              <p key={key}>
                <code>{key}</code>: {draft} →{' '}
                {key === 'providers'
                  ? 'provider list changed'
                  : valueText(conflict.projection.settings.safeDefaults[key]?.value)}
              </p>
            ))}
          </div>
          {Object.keys(drafts).includes('providers') && (
            <p className="mt-2 text-xs">
              Providers require an explicit merge/re-edit; they are not merged automatically.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void reload()} className="rounded border px-2 py-1 text-xs">
              Reload
            </button>
            <button
              type="button"
              disabled={Object.keys(drafts).includes('providers')}
              onClick={() => void keepDraft()}
              className="rounded border px-2 py-1 text-xs disabled:opacity-40"
            >
              Keep my change
            </button>
            <button type="button" onClick={() => setConflict(null)} className="rounded border px-2 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Safe defaults</h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Settings set by CLI flags or the session runtime are read-only in this panel.
        </p>
        <div className="mt-2 space-y-2">
          {Object.entries(projection.settings.safeDefaults).map(([key, setting]) => {
            const isReadOnly = !setting.persistable;
            const tooltip = isReadOnly
              ? `Read-only: set by ${setting.source} (${setting.scope} scope)`
              : `Edit setting ${key}`;

            return (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 p-2 text-sm dark:border-zinc-700"
              >
                <label className="min-w-40 flex-1" htmlFor={`term2-setting-${key}`} title={tooltip}>
                  {key}{' '}
                  <span className="ml-2 text-xs text-zinc-500">
                    {setting.scope} · {setting.source}
                  </span>
                </label>
                <input
                  id={`term2-setting-${key}`}
                  aria-label={`${key} (${setting.scope} · ${setting.source})`}
                  title={tooltip}
                  value={drafts[key] ?? valueText(setting.value)}
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                  disabled={isReadOnly || busy}
                  className={`min-w-32 flex-1 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 ${
                    isReadOnly
                      ? 'bg-zinc-100 text-zinc-800 opacity-100 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-200'
                      : 'bg-transparent'
                  }`}
                />
                <button
                  type="button"
                  disabled={busy || isReadOnly}
                  title={isReadOnly ? tooltip : `Save ${key}`}
                  onClick={() => requestChange(key, drafts[key] ?? valueText(setting.value), setting.confirmRequired)}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-white disabled:opacity-40"
                >
                  Save
                </button>
                {setting.confirmRequired && <span className="text-[10px] text-amber-700">confirmation required</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Providers</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {projection.settings.providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between rounded border border-zinc-200 px-2 py-1 dark:border-zinc-700"
            >
              <span>
                {provider.label} <span className="text-xs text-zinc-500">({provider.id})</span>
              </span>
              <span className="text-xs text-zinc-500">
                {provider.active ? 'active' : 'inactive'} ·{' '}
                {provider.credential.configured ? `configured (${provider.credential.source})` : 'not configured'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Safety</h3>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <dt>Sandbox</dt>
          <dd>{projection.settings.safety.sandbox}</dd>
          <dt>Approval</dt>
          <dd>{projection.settings.safety.approval}</dd>
          <dt>Workspace access</dt>
          <dd>{projection.settings.safety.workspaceAccess}</dd>
          <dt>Network</dt>
          <dd>{projection.settings.safety.network}</dd>
          <dt>Background shell</dt>
          <dd>{projection.settings.safety.backgroundShell}</dd>
        </dl>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Credentials</h3>
        <div className="mt-2 space-y-2">
          {Object.entries(projection.settings.credentials).map(([id, credential]) => (
            <div key={id} className="rounded border border-zinc-200 p-2 dark:border-zinc-700">
              <div className="flex items-center justify-between text-sm">
                <span>{id}</span>
                <span className="text-xs text-zinc-500">
                  {credential.configured ? `configured (${credential.source})` : 'not configured'}
                </span>
              </div>
              {/* A password input outside a <form> trips the browser's
                  "password field is not contained in a form" warning; wrap the
                  row so password managers/auditors stay quiet. Buttons stay
                  type="button" and submit is suppressed. */}
              <form className="mt-2 flex gap-2" onSubmit={(event) => event.preventDefault()} noValidate>
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label={`New value for ${id}`}
                  value={credentialDrafts[id] ?? ''}
                  onChange={(event) => setCredentialDrafts((current) => ({ ...current, [id]: event.target.value }))}
                  disabled={!credential.writable || credential.source === 'environment'}
                  placeholder={credential.source === 'environment' ? 'Provided by environment' : 'Enter a new value'}
                  className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-600"
                />
                <button
                  type="button"
                  disabled={!credential.writable || credential.source === 'environment' || !credentialDrafts[id]}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const result = await term2Client.setCredential(id, credentialDrafts[id]);
                      setMessage(
                        `${id}: ${result.configured ? 'configured' : 'not configured'} (${result.source ?? 'stored'})`,
                      );
                      setCredentialDrafts((current) => ({ ...current, [id]: '' }));
                      // Provider status is derived from the credentials projection;
                      // refresh so the providers list stops showing stale state.
                      await reload();
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : 'Credential was not saved');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-white disabled:opacity-40"
                >
                  Set
                </button>
                <button
                  type="button"
                  disabled={
                    !credential.writable || credential.source === 'environment' || !credential.configured || busy
                  }
                  title={!credential.configured ? 'Credential is not configured' : `Delete stored credential for ${id}`}
                  onClick={() => {
                    openConfirm({
                      key: `credential:${id}`,
                      value: '',
                      consequence: `Delete stored credential for "${id}"? You will need to enter a new API key or secret to use this provider.`,
                    });
                  }}
                  className="rounded border px-2 py-1 text-xs disabled:opacity-40"
                >
                  Delete
                </button>
              </form>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">OAuth accounts</h3>
        {Object.entries(projection.settings.oauthAccounts).map(([provider, accounts]) => (
          <div key={provider} className="mt-2">
            <div className="text-xs font-medium text-zinc-500">{provider}</div>
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between py-1 text-sm">
                <span>
                  {account.label}{' '}
                  <span className="text-xs text-zinc-500">
                    {account.isSelected ? 'selected' : ''}
                    {account.isInUse ? ' · in use' : ''}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      await term2Client.oauthSelect(provider, account.id);
                      await reload();
                    }}
                    className="text-xs underline"
                  >
                    Select
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await term2Client.oauthDelete(provider, account.id);
                      await reload();
                    }}
                    className="text-xs text-red-700 underline"
                  >
                    Delete
                  </button>
                </span>
              </div>
            ))}
            <button
              type="button"
              onClick={async () => {
                const result = await term2Client.oauthLogin(provider);
                setMessage(
                  result.status === 'completed' ? 'OAuth login completed.' : 'OAuth login not completed; retry.',
                );
                await reload();
              }}
              className="text-xs underline"
            >
              Login
            </button>
          </div>
        ))}
      </div>

      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="term2-confirm-heading"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeConfirm();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="max-w-md rounded-xl bg-white p-5 text-zinc-900 shadow-xl dark:bg-zinc-900 dark:text-zinc-100">
            <h3 id="term2-confirm-heading" className="font-semibold">
              {confirm.key.startsWith('credential:') ? 'Delete credential' : 'Confirm setting change'}
            </h3>
            <p className="mt-2 text-sm">{confirm.consequence}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={confirmCancelButtonRef}
                type="button"
                onClick={closeConfirm}
                className="rounded border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const pending = confirm;
                  closeConfirm();
                  if (pending.key.startsWith('credential:')) {
                    const credId = pending.key.slice('credential:'.length);
                    setBusy(true);
                    try {
                      await term2Client.deleteCredential(credId);
                      setMessage(`${credId}: deleted`);
                      await reload();
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : 'Credential was not deleted');
                    } finally {
                      setBusy(false);
                    }
                  } else {
                    void submit(pending.key, pending.value);
                  }
                }}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
