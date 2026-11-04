import React from 'react';
import type { WireRewindTarget } from '../../protocol/direct-wire.js';
import type { TuiConnection, TuiProps } from './integration.js';
import type { TuiState } from './state.js';
import { PickerHost, type PickerKind } from './picker-host.js';
import { BudgetPanel } from './budget-panel.js';
import { RewindPicker } from './rewind-picker.js';
import type { InteractionInput } from './interaction-input.js';
import { answerBudget } from './commands.js';

type Props = {
  picker: PickerKind | null;
  integration: TuiProps['integration'];
  connection: TuiConnection;
  interactionInput: InteractionInput;
  onNotice: (notice: string | null) => void;
  switchSession?: (sessionId: string) => Promise<void>;
  budgetOpen: boolean;
  rewindTargets: readonly WireRewindTarget[] | null;
  state: TuiState;
  columns: number;
  closePicker: () => void;
  closeBudget: () => void;
  closeRewind: () => void;
  executeRewind: (id: string, disposition: 'edit' | 'resend') => Promise<void>;
};

/** Modal surfaces share input ownership; the session retains their state and routing. */
export function SessionPanels({
  picker,
  integration,
  connection,
  interactionInput,
  onNotice: setNotice,
  switchSession,
  budgetOpen,
  rewindTargets,
  state,
  columns,
  closePicker,
  closeBudget,
  closeRewind,
  executeRewind,
}: Props): React.ReactElement {
  return (
    <>
      {picker ? (
        <PickerHost
          kind={picker}
          integration={integration}
          connection={connection}
          inputHandler={interactionInput}
          close={() => closePicker()}
          onNotice={setNotice}
          switchSession={switchSession}
        />
      ) : null}
      {budgetOpen ? (
        <BudgetPanel
          requests={state.budgets}
          onClose={() => closeBudget()}
          onAnswer={(id, decision) => answerBudget(connection, id, decision)}
        />
      ) : null}
      {rewindTargets ? (
        <RewindPicker
          targets={rewindTargets}
          onClose={() => closeRewind()}
          onSelect={(id, disposition) => {
            void executeRewind(id, disposition);
          }}
        />
      ) : null}
    </>
  );
}
