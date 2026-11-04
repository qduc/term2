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
  interactionActive: boolean;
  foregroundInteraction: TuiState['interactions'][number] | undefined;
  columns: number;
  closePicker: () => void;
  closeBudget: () => void;
  closeTask: () => void;
  closeRewind: () => void;
  closeInteraction: () => void;
  executeRewind: (id: string, disposition: 'edit' | 'resend') => Promise<void>;
  cancelInput: (connection: TuiConnection, turnId?: string) => Promise<string>;
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
  foregroundInteraction,
  columns,
  closePicker,
  closeBudget,
  closeTask,
  closeRewind,
  closeInteraction,
  executeRewind,
  cancelInput,
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
          key={foregroundInteraction?.id ?? 'picker'}
          interactions={state.interactions}
          width={columns}
          initialRequestId={foregroundInteraction?.id}
          inputHandler={interactionInput}
          onClose={() => {
            closeInteraction();
          }}
          onCancel={
            foregroundInteraction
              ? async () => {
                  if (foregroundInteraction.kind === 'question')
                    await answerInteraction(connection, foregroundInteraction.id, { kind: 'decline' });
                  else setNotice(await cancelInput(connection, foregroundInteraction.turnId));
                }
              : undefined
          }
          onAnswer={(id, decision) => answerInteraction(connection, id, decision)}
        />
      ) : null}
    </>
  );
}
