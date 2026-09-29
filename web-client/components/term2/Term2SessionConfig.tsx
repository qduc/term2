'use client';

import { useMemo, useState } from 'react';
import { term2Client, Term2ApiError } from '../../lib/api/term2';
import type { SessionConfigRecord, SettingsProjection } from '../../lib/term2/types';

export function isSessionConfigStale(
  config: SessionConfigRecord | null | undefined,
  settings: SettingsProjection | null | undefined,
): boolean {
  return Boolean(config && settings && config.defaultsRevision !== settings.revision);
}

export function Term2SessionConfig({
  config,
  settings,
  sessionId,
  onApplyToFutureTurns,
  onCreateNewSession,
  reauthenticationRequired = false,
}: {
  config?: SessionConfigRecord | null;
  settings?: SettingsProjection | null;
  sessionId?: string | null;
  onApplyToFutureTurns?: () => void;
  onCreateNewSession?: () => void;
  reauthenticationRequired?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = useMemo(() => isSessionConfigStale(config, settings), [config, settings]);
  if (!config) return null;
  const update = async (field: 'model' | 'reasoningEffort' | 'mode', value: string) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await term2Client.updateSessionConfig(sessionId, { [field]: value });
    } catch (reason) {
      setError(reason instanceof Term2ApiError ? reason.message : 'Session configuration was not updated.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="term2-session-config-heading"
      className="border-b border-zinc-200 bg-white px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="term2-session-config-heading" className="font-semibold">
          Session configuration
        </h2>
        <span>Provider: {config.providerId}</span>
        <span>Model: {config.modelId}</span>
        <span>Reasoning: {config.reasoningEffort}</span>
        <span>Mode: {config.mode}</span>
      </div>
      {reauthenticationRequired && (
        <p role="alert" className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-amber-950">
          Reauthentication is required for this session&apos;s captured provider account.
        </p>
      )}
      {stale && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-amber-950"
        >
          <span>Session uses older defaults.</span>
          <button type="button" onClick={onApplyToFutureTurns} className="underline">
            Apply to future turns
          </button>
          <button type="button" onClick={onCreateNewSession} className="underline">
            Create new session
          </button>
        </div>
      )}
      {config && sessionId && (
        <details className="mt-1">
          <summary className="cursor-pointer text-zinc-500">Change session config</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <label>
              Model{' '}
              <input
                aria-label="Session model"
                defaultValue={config.modelId}
                disabled={busy}
                onBlur={(event) => {
                  if (event.target.value !== config.modelId) void update('model', event.target.value);
                }}
                className="ml-1 rounded border px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label>
              Reasoning{' '}
              <input
                aria-label="Session reasoning effort"
                defaultValue={config.reasoningEffort}
                disabled={busy}
                onBlur={(event) => {
                  if (event.target.value !== config.reasoningEffort) void update('reasoningEffort', event.target.value);
                }}
                className="ml-1 rounded border px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label>
              Mode{' '}
              <select
                aria-label="Session mode"
                defaultValue={config.mode}
                disabled={busy}
                onChange={(event) => void update('mode', event.target.value)}
                className="ml-1 rounded border px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="standard">standard</option>
                <option value="lite">lite</option>
                <option value="plan">plan</option>
                <option value="mentor">mentor</option>
                <option value="orchestrator">orchestrator</option>
              </select>
            </label>
          </div>
        </details>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
