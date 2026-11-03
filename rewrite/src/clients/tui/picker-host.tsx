import React from 'react';
import type { TuiConnection, TuiIntegration } from './integration.js';
import type { InteractionInput } from './interaction-input.js';
import { ModelPicker } from './model-picker.js';
import { ResumePicker } from './resume-picker.js';
import { SettingsPicker } from './settings-picker.js';

export type PickerKind = 'model' | 'resume' | 'settings';

/** The picker a typed command opens, if the app supplied one: `/model` and `/resume` with no argument. */
export function pickerFor(integration: TuiIntegration, command: string): PickerKind | null {
  if (command === '/resume' && integration.resumePicker) return 'resume';
  if (command === '/settings' && integration.settingsPicker) return 'settings';
  return command === '/model' && integration.modelPicker ? 'model' : null;
}

/** Hand a slash-menu Enter selection to the same picker used by direct submission. */
export function openPickerFor(integration: TuiIntegration, show: (target: PickerKind) => void) {
  return (command: string): boolean => {
    const target = pickerFor(integration, command);
    if (!target) return false;
    show(target);
    return true;
  };
}

/** One full-screen choice list at a time; it owns the keys through the session's shared input ref. */
export function PickerHost(props: {
  readonly kind: PickerKind;
  readonly integration: TuiIntegration;
  readonly connection: TuiConnection;
  readonly inputHandler: InteractionInput;
  readonly close: () => void;
  readonly onNotice: (text: string | null) => void;
  readonly switchSession?: (sessionId: string) => Promise<void>;
}): React.ReactElement | null {
  const { kind, integration, connection, inputHandler, close, onNotice, switchSession } = props;
  const failure = (error: unknown) => onNotice(error instanceof Error ? error.message : String(error));
  if (kind === 'settings' && integration.settingsPicker)
    return (
      <SettingsPicker
        api={integration.settingsPicker}
        sessionId={connection.sessionId}
        inputHandler={inputHandler}
        onClose={close}
        onNotice={onNotice}
        run={(text) => integration.command(connection, text)}
      />
    );
  if (kind === 'model' && integration.modelPicker)
    return (
      <ModelPicker
        api={integration.modelPicker}
        sessionId={connection.sessionId}
        inputHandler={inputHandler}
        onClose={close}
        run={(text) => integration.command(connection, text)}
        onNotice={onNotice}
      />
    );
  if (kind === 'resume' && integration.resumePicker)
    return (
      <ResumePicker
        api={integration.resumePicker}
        inputHandler={inputHandler}
        onClose={close}
        onSelect={(id) => {
          close();
          if (!switchSession) return onNotice('Session switching is unavailable.');
          void switchSession(id).catch(failure);
        }}
      />
    );
  return null;
}
