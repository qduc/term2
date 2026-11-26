/**
 * Preferences kept in this browser: display mode, notifications, diagnostics and the prompt history. Read once after
 * mount (`hydrate`), so the server render and the first client render agree. No React here.
 */
import type { Term2DisplayMode } from '../../components/term2/Term2TurnTimeline';
import { createStore, type ReadableStore } from './store';

const PROMPT_HISTORY_KEY = 'term2.web.promptHistory';
const DISPLAY_MODE_KEY = 'term2.web.displayMode';
const NOTIFICATIONS_KEY = 'term2.web.notifications';
const DIAGNOSTICS_KEY = 'term2.web.diagnostics';

export type BrowserPrefsState = {
  readonly displayMode: Term2DisplayMode;
  readonly notificationsEnabled: boolean;
  readonly showDiagnostics: boolean;
  readonly promptHistory: readonly string[];
};

export interface BrowserPrefs extends ReadableStore<BrowserPrefsState> {
  hydrate(): void;
  setDisplayMode(mode: Term2DisplayMode): void;
  setNotifications(enabled: boolean): void;
  setDiagnostics(enabled: boolean): void;
  rememberPrompt(text: string): void;
}

function readLocalString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readPromptHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(PROMPT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

/** Read when a session's stream is created, straight from localStorage. */
export function diagnosticsOn(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(DIAGNOSTICS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function createBrowserPrefs(): BrowserPrefs {
  const store = createStore<BrowserPrefsState>({
    displayMode: 'concise',
    notificationsEnabled: false,
    showDiagnostics: false,
    promptHistory: [],
  });
  return {
    get: store.get,
    subscribe: store.subscribe,
    hydrate() {
      const savedDisplay = readLocalString(DISPLAY_MODE_KEY);
      store.set((state) => ({
        ...state,
        // 'detailed' is the earlier name for standard.
        ...(savedDisplay === 'standard' || savedDisplay === 'detailed'
          ? { displayMode: 'standard' as const }
          : savedDisplay === 'concise'
          ? { displayMode: 'concise' as const }
          : {}),
        ...(readLocalString(NOTIFICATIONS_KEY) === 'true' ? { notificationsEnabled: true } : {}),
        ...(readLocalString(DIAGNOSTICS_KEY) === 'true' ? { showDiagnostics: true } : {}),
        promptHistory: readPromptHistory(),
      }));
    },
    setDisplayMode(mode) {
      store.set((state) => ({ ...state, displayMode: mode }));
      writeLocal(DISPLAY_MODE_KEY, mode);
    },
    setNotifications(enabled) {
      store.set((state) => ({ ...state, notificationsEnabled: enabled }));
      writeLocal(NOTIFICATIONS_KEY, String(enabled));
    },
    setDiagnostics(enabled) {
      store.set((state) => ({ ...state, showDiagnostics: enabled }));
      writeLocal(DIAGNOSTICS_KEY, String(enabled));
    },
    rememberPrompt(text) {
      store.set((state) => {
        const prev = state.promptHistory;
        const next = prev[prev.length - 1] === text ? prev : [...prev.slice(-49), text];
        writeLocal(PROMPT_HISTORY_KEY, JSON.stringify(next));
        return next === prev ? state : { ...state, promptHistory: next };
      });
    },
  };
}
