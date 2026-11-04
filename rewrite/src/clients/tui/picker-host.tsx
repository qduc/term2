import React from 'react';
import type { TuiConnection, TuiIntegration } from './integration.js';
import type { InteractionInput } from './interaction-input.js';
import { ResumePicker } from './resume-picker.js';

export type PickerKind = 'resume';

/** The picker a typed command opens: `/resume`. */
export function pickerFor(integration: TuiIntegration, command: string): PickerKind | null {
  if (command === '/resume' && integration.resumePicker) return 'resume';
  return null;
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
