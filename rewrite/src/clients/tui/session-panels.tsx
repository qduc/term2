import React from 'react';
import type { TuiConnection } from './integration.js';
import type { TuiState } from './state.js';
import { BudgetPanel } from './budget-panel.js';
import type { InteractionInput } from './interaction-input.js';
import { answerBudget } from './commands.js';

type Props = {
  connection: TuiConnection;
  interactionInput: InteractionInput;
  onNotice: (notice: string | null) => void;
  budgetOpen: boolean;
  state: TuiState;
  columns: number;
  closeBudget: () => void;
};

/** Modal surfaces share input ownership; the session retains their state and routing. */
export function SessionPanels({
  connection,
  interactionInput,
  onNotice: setNotice,
  budgetOpen,
  state,
  columns,
  closeBudget,
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
    </>
  );
}
