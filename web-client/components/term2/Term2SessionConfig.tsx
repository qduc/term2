'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentConfigureResultV2 } from '@qduc/agent-wire';
import { term2Client, Term2ApiError } from '../../lib/api/term2';
import type { SessionConfigRecord, SessionConfigUpdate, SettingsProjection } from '../../lib/term2/types';

export function isSessionConfigStale(
  config: SessionConfigRecord | null | undefined,
  settings: SettingsProjection | null | undefined,
): boolean {
  return Boolean(config && settings && config.defaultsRevision !== settings.defaultsRevision);
}

/** A mutation's original receipt is not the current-state configuration.
 * Retry/check retains the exact command key, original revision and selection. */
export function Term2SessionConfig({ config, settings, sessionId, onDiscovered, onCreateNewSession, reauthenticationRequired = false }: {
  config?: SessionConfigRecord | null;
  settings?: SettingsProjection | null;
  sessionId?: string | null;
  onDiscovered?: (config: SessionConfigRecord) => void;
  onCreateNewSession?: () => void;
  reauthenticationRequired?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<SessionConfigUpdate | null>(null);
  const [receipt, setReceipt] = useState<AgentConfigureResultV2 | null>(null);
  // Ref closes the same-render double-submit window, without re-keying retries.
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const stale = useMemo(() => isSessionConfigStale(config, settings), [config, settings]);
  if (!config) return null;

  const submit = async (request: SessionConfigUpdate) => {
    if (!sessionId || submitting.current) return;
    submitting.current = true;
    setOriginal(request);
    setBusy(true);
    setError(null);
    try {
      const response = await term2Client.updateSessionConfig(sessionId, request);
      if (!mounted.current) return;
      setReceipt(response);
      const result = response.result;
      if (result.ok && result.kind === 'command_finished') {
        setOriginal(null);
        // Discovery can be newer than this receipt; never relabel it as this outcome.
        try { const current = await term2Client.readSessionConfig(sessionId); if (mounted.current) onDiscovered?.(current); }
        catch { setError('Command finished; current configuration could not be refreshed. Original receipt is shown below.'); }
      } else if (!result.ok && 'receipt' in result) {
        setOriginal(null); // Native terminal rejection/interruption is displayed, not retried as new intent.
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Term2ApiError ? reason.message : 'Command outcome is unknown. Retry the original request to resolve it.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const update = (selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode'>) => {
    if (!sessionId || original || submitting.current) return;
    setReceipt(null);
    void submit({ clientRequestId: crypto.randomUUID(), expectedRevision: config.configRevision, admission: 'idle', ...selection });
  };
  const result = receipt?.result;
  const outcome = result && 'receipt' in result ? result.receipt.outcome : undefined;
  const blocked = busy || original !== null;
  return (
    <section aria-labelledby="term2-session-config-heading" className="border-b border-zinc-200 bg-white px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="term2-session-config-heading" className="font-semibold">Current session configuration (discovery)</h2>
        <span>Model: {config.modelId}</span><span>Reasoning: {config.reasoningEffort}</span><span>Mode: {config.mode}</span>
      </div>
      {reauthenticationRequired && <p role="alert">Reauthentication is required for this session&apos;s captured provider account.</p>}
      {stale && <p>Session captured older defaults. Edit explicitly below or <button type="button" onClick={onCreateNewSession} className="underline">create a new session</button>.</p>}
      {sessionId && <details className="mt-2">
        <summary className="cursor-pointer">Change session configuration</summary>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label>Model <input aria-label="Session model" key={`${config.configRevision}:model`} defaultValue={config.modelId} disabled={blocked}
            onBlur={(event) => { if (event.target.value !== config.modelId) update({ modelSelection: { model: event.target.value, provider: config.providerId } }); }} className="ml-1 rounded border px-1 py-0.5" /></label>
          <label>Reasoning <select aria-label="Session reasoning effort" value={config.reasoningEffort} disabled={blocked}
            onChange={(event) => update({ reasoningEffort: event.target.value as SessionConfigUpdate['reasoningEffort'] })} className="ml-1 rounded border px-1 py-0.5">
            {['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label>Mode <select aria-label="Session mode" value={config.mode} disabled={blocked}
            onChange={(event) => update({ mode: event.target.value as SessionConfigRecord['mode'] })} className="ml-1 rounded border px-1 py-0.5">
            {['standard', 'lite', 'plan', 'mentor', 'orchestrator'].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </div>
      </details>}
      {result && <div role="status" className="mt-2">
        {result.ok ? result.kind === 'command_pending' ? 'Command pending — no configured outcome yet.' : 'Original command finished.' : `Command not configured: ${result.code} — ${result.message}`}
        {'replayed' in result && result.replayed !== undefined && <span> Replayed: {String(result.replayed)}.</span>}
        {outcome?.kind === 'configured' && <p>Original configured outcome: {outcome.configuration.model.provider}/{outcome.configuration.model.model}{outcome.configuration.reasoning !== undefined ? ` · ${outcome.configuration.reasoning}` : ''}{outcome.configuration.temperature !== undefined ? ` · temperature ${outcome.configuration.temperature}` : ''}</p>}
        <details><summary>Original native result / admission revision</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(receipt, null, 2)}</pre></details>
      </div>}
      {sessionId && <button type="button" disabled={busy} className="mt-2 underline" onClick={() => {
        void term2Client.readSessionConfig(sessionId).then(value => onDiscovered?.(value)).catch(() => setError('Current-state discovery failed; original command evidence is unchanged.'));
      }}>Refresh current configuration (separate discovery)</button>}
      {original && <details><summary>Original request retained for retry</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(original, null, 2)}</pre></details>}
      {original && <p className="mt-2">Keep this request until its outcome is known. <button type="button" disabled={busy} onClick={() => void submit(original)} className="underline">Check / retry original command</button></p>}
      {error && <p role="alert" className="mt-1 text-red-700">{error}</p>}
    </section>
  );
}
