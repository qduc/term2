import { useEffect, useRef } from 'react';
import type { WireEvent } from '../../protocol/direct-wire.js';
import { formatGoalClosedByCheck } from '../../protocol/direct-json.js';
import type { TuiState } from './state.js';

/**
 * Legacy app.tsx's goalAchievedSlot handler: a goal the model's goal_check closed
 * gets one transcript line, held until the turn settles. Returns the live-event observer.
 */
export function useGoalClosedNotice(state: TuiState, notice: (text: string) => void): (event: WireEvent) => void {
  const pending = useRef<string | null>(null);
  const processing = state.status !== 'idle' || Boolean(state.activeTurnId);
  useEffect(() => {
    if (processing || !pending.current) return;
    const text = pending.current;
    pending.current = null;
    notice(text);
  });
  return (event) => {
    if (event.type !== 'goal') return;
    const { goal, source } = event.payload;
    if (source !== 'goal_check' || goal?.status !== 'achieved') return;
    pending.current = formatGoalClosedByCheck({
      id: goal.id,
      outcome: goal.text,
      status: 'achieved',
      ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
    });
  };
}
