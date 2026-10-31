/** Runtime settings submission command: model, reasoning effort and temperature changes. */
import {
  parseRuntimeMutation,
  type RuntimeSettingMutation,
  type RuntimeSettingsSnapshot,
} from '../../../../source/services/settings/session-runtime-settings.js';
import type { AdoptedCommandDeps } from './submission.js';

export interface AdoptedRuntimeSettings {
  supports(command: RuntimeSettingMutation): boolean;
  setOverride(command: RuntimeSettingMutation): void;
  snapshot(): RuntimeSettingsSnapshot;
}

export function createSettingsCommand(deps: AdoptedCommandDeps, runtimeSettings: AdoptedRuntimeSettings | undefined) {
  const { context, runtime, turn, commit, poison } = deps;
  const settingPending = new Map<
    string,
    Promise<{ kind: 'applied'; settings: RuntimeSettingsSnapshot } | { kind: 'unsupported' }>
  >();
  return {
    setRuntimeSettings(input: RuntimeSettingMutation) {
      try {
        context.assertHealthy();
      } catch (error) {
        return Promise.reject(error);
      }
      if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
      let command: RuntimeSettingMutation;
      try {
        command = parseRuntimeMutation(input);
      } catch (error) {
        return Promise.reject(error);
      }
      const key =
        command.kind === 'model'
          ? JSON.stringify(['model', command.selection.provider, command.selection.model])
          : command.kind === 'reasoning'
          ? JSON.stringify(['reasoning', command.effort])
          : JSON.stringify(['temperature', command.temperature ?? null]);
      const existing = settingPending.get(key);
      if (existing) return existing;
      if (!runtimeSettings || !runtimeSettings.supports(command))
        return Promise.resolve({ kind: 'unsupported' as const });
      if (turn.closing || turn.interrupting || turn.compacting || context.state().status === 'closed')
        return Promise.reject(new Error('Session is unavailable'));
      if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
      if (!turn.settingMutation) {
        try {
          turn.releaseSettings = context.reserveSettings();
        } catch (error) {
          return Promise.reject(error);
        }
        turn.settingMutation = true;
      }
      const operation = turn.queue(async () => {
        context.assertHealthy();
        if (turn.closing || turn.poisoned !== undefined) throw new Error('Session is unavailable');
        const signal = turn.stop();
        await turn.settle(signal);
        signal.throwIfAborted();
        if (turn.closing || turn.poisoned !== undefined) throw new Error('Session is unavailable');
        try {
          runtimeSettings!.setOverride(command);
          if (command.kind === 'model') runtime.runtimeController.setModelSelection(command.selection);
          else if (command.kind === 'reasoning') runtime.runtimeController.setReasoningEffort(command.effort);
          else runtime.runtimeController.setTemperature(command.temperature);
          const settings = runtimeSettings!.snapshot();
          const key =
            command.kind === 'model'
              ? 'agent.modelSelection'
              : command.kind === 'reasoning'
              ? 'agent.reasoningEffort'
              : 'agent.temperature';
          const value =
            command.kind === 'model'
              ? settings.selection
              : command.kind === 'reasoning'
              ? settings.reasoningEffort
              : settings.temperature;
          await commit([{ type: 'settings_changed', key, value, sessionMutation: 1 }]);
          context.assertHealthy();
          if (turn.poisoned !== undefined) throw turn.poisoned;
          if (turn.closing || signal.aborted) throw new Error('Settings became stale');
          return { kind: 'applied' as const, settings };
        } catch (error) {
          poison(error ?? new Error('Settings mutation failed'));
          turn.cancelRun();
          throw turn.poisoned;
        }
      });
      const promise = operation.finally(() => {
        settingPending.delete(key);
        if (!settingPending.size) {
          turn.settingMutation = false;
          turn.releaseSettings?.();
          turn.releaseSettings = undefined;
        }
      });
      settingPending.set(key, promise);
      return promise;
    },
  };
}
