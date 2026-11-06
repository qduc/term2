import React from 'react';
import { Box } from 'ink';
import { queueAction } from './commands.js';
import type { TuiConnection } from './integration.js';
import type { TuiState } from './state.js';
import QueuePausedPrompt from './presentation/components/prompt/QueuePausedPrompt.js';

/**
 * Legacy input-owner `queue-paused`: a paused queue owns the keys in the composer's place unless the draft is a
 * command (`/` types one and keeps the queue paused). `r` resumes, `x` discards.
 */
export function useQueuePaused(options: {
  readonly state: TuiState;
  readonly connection: TuiConnection;
  /** No panel, confirmation, menu or queued-message edit owns the keys. */
  readonly active: boolean;
  readonly draft: string;
  readonly replaceInput: (text: string) => void;
  readonly notice: (text: string) => void;
}) {
  const { state, connection, replaceInput, notice } = options;
  const shown = options.active && state.queueState === 'paused' && !options.draft.startsWith('/');
  const run = (action: 'resume' | 'discard') =>
    void queueAction(connection, action).catch((error: unknown) =>
      notice(error instanceof Error ? error.message : String(error)),
    );
  return {
    shown,
    // Legacy BottomArea's top-content box: a blank row under the prompt.
    prompt: shown ? (
      <Box flexDirection="column" marginBottom={1}>
        <QueuePausedPrompt
          queueLength={state.queue.length}
          pauseReason={state.queuePauseReason}
          onResume={() => run('resume')}
          onDiscard={() => run('discard')}
          onCommand={replaceInput}
        />
      </Box>
    ) : null,
  };
}
