import type { ToolExecutionLifecyclePort } from '../../tools/types.js';
import type { HookLifecyclePort } from './hook-service.js';
import type { HookEventFactory } from './hook-event-factory.js';
import { summarizeHookValue } from './hook-event-factory.js';

/** Adapts the application run-loop seam to the public observational contract. */
export function createToolExecutionLifecyclePort(
  lifecycle: HookLifecyclePort,
  events: HookEventFactory,
): ToolExecutionLifecyclePort {
  return {
    async before(context) {
      await lifecycle.emit(
        events.create(
          'tool.before',
          {
            toolName: context.toolName,
            normalizedArguments: events.includeToolArguments
              ? context.normalizedArguments
              : summarizeHookValue(context.normalizedArguments),
            attempt: context.attempt,
            ownership: context.scope,
          },
          { turnId: context.turnId, toolCallId: context.toolCallId },
          context.scope,
        ),
      );
    },
    async after(context, result, duration) {
      await lifecycle.emit(
        events.create(
          'tool.after',
          {
            toolName: context.toolName,
            duration,
            normalizedResultSummary: events.includeToolResults ? result : summarizeHookValue(result),
          },
          { turnId: context.turnId, toolCallId: context.toolCallId },
          context.scope,
        ),
      );
    },
    async error(context, error, duration, convertedToModelResult) {
      await lifecycle.emit(
        events.create(
          'tool.error',
          {
            toolName: context.toolName,
            duration,
            errorCategory: 'tool',
            safeMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            convertedToModelResult,
          },
          { turnId: context.turnId, toolCallId: context.toolCallId },
          context.scope,
        ),
      );
    },
  };
}
