import React from 'react';
import type { WireRewindTarget } from '../../protocol/direct-wire.js';
import type { TuiConnection, TuiProps } from './integration.js';
import type { TuiState } from './state.js';
import { PickerHost, type PickerKind } from './picker-host.js';
import { BudgetPanel } from './budget-panel.js';
import { TaskManager } from './task-manager.js';
import { RewindPicker } from './rewind-picker.js';
import { InteractionPanel } from './interaction-panel.js';
import type { InteractionInput } from './interaction-input.js';
import { answerBudget, answerInteraction, controlTask } from './commands.js';

type Props = {
  picker: PickerKind | null;
  integration: TuiProps['integration'];
  connection: TuiConnection;
  interactionInput: InteractionInput;
  onNotice: (notice: string | null) => void;
  switchSession?: (sessionId: string) => Promise<void>;
  budgetOpen: boolean;
  taskOpen: boolean;
  rewindTargets: readonly WireRewindTarget[] | null;
  state: TuiState;
  /** The Ctrl+G request picker; the foreground turn's request is approval-host.tsx's. */
  interactionActive: boolean;
  columns: number;
  closePicker: () => void;
  closeBudget: () => void;
  closeTask: () => void;
  closeRewind: () => void;
  closeInteraction: () => void;
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
  taskOpen,
  rewindTargets,
  state,
  interactionActive,
  columns,
  closePicker,
  closeBudget,
  closeTask,
  closeRewind,
  closeInteraction,
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
      {taskOpen ? (
        <TaskManager
          tasks={state.tasks}
          onClose={() => closeTask()}
          onAction={(id, action) => controlTask(connection, id, action)}
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

      {interactionActive ? (
        <InteractionPanel
          interactions={state.interactions}
          width={columns}
          inputHandler={interactionInput}
          onClose={() => {
            closeInteraction();
          }}
          onAnswer={(id, decision) => answerInteraction(connection, id, decision)}
        />
      ) : null}
    </>
  );
}
