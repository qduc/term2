import React from 'react';
import type { TuiConnection } from './integration.js';
import type { TuiState } from './state.js';
import { BudgetPanel } from './budget-panel.js';
import { TaskManager } from './task-manager.js';
import { InteractionPanel } from './interaction-panel.js';
import type { InteractionInput } from './interaction-input.js';
import { answerBudget, answerInteraction, controlTask } from './commands.js';

type Props = {
  connection: TuiConnection;
  interactionInput: InteractionInput;
  onNotice: (notice: string | null) => void;
  budgetOpen: boolean;
  taskOpen: boolean;
  state: TuiState;
  interactionActive: boolean;
  foregroundInteraction: TuiState['interactions'][number] | undefined;
  columns: number;
  closeBudget: () => void;
  closeTask: () => void;
  closeInteraction: () => void;
  cancelInput: (connection: TuiConnection, turnId?: string) => Promise<string>;
};

/** Modal surfaces share input ownership; the session retains their state and routing. */
export function SessionPanels({
  connection,
  interactionInput,
  onNotice: setNotice,
  budgetOpen,
  taskOpen,
  state,
  interactionActive,
  foregroundInteraction,
  columns,
  closeBudget,
  closeTask,
  closeInteraction,
  cancelInput,
}: Props): React.ReactElement {
  return (
    <>
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
