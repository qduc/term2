import type { z, ZodTypeAny } from 'zod';
import type {
  AnyToolDefinition,
  PostExecutePauseCapability as PostExecutePauseCapabilityPort,
  PostExecutePolicy,
  SchemaToolDefinition,
} from '../../tools/types.js';
import { createPostExecutePausePolicy } from './post-execute-pause-policy.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

/**
 * Session-owned construction capability. It is deliberately supplied only to
 * the root AgentClient: nested/subagent tool factories retain their existing
 * behavior until a later slice gives them an explicit ownership model.
 */
export class PostExecutePauseCapability implements PostExecutePauseCapabilityPort {
  #activeRunId: string | null = null;

  constructor(readonly pending: PostExecutePendingRegistry) {}

  setActiveRunId(runId: string | null): void {
    this.#activeRunId = runId;
  }

  forTool<TSchema extends ZodTypeAny>(
    definition: SchemaToolDefinition<TSchema>,
  ): PostExecutePolicy<z.infer<TSchema>> | undefined;
  forTool(definition: AnyToolDefinition): PostExecutePolicy<unknown> | undefined;
  forTool(definition: AnyToolDefinition): PostExecutePolicy<unknown> | undefined {
    if (!definition.postExecutePause) return undefined;
    return createPostExecutePausePolicy({
      pending: this.pending,
      runId: () => this.#activeRunId,
      describe: definition.postExecutePause.describe,
      resolve: definition.postExecutePause.resolve,
    });
  }
}
