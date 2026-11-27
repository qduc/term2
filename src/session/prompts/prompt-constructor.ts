import type { ExecutionContext } from '../../tools/execution-context.js';
import type { ResolvedProfile } from '../../config/profiles/index.js';
import { renderBareToolGuidance } from './tool-surface-guidance.js';
import type { ScriptEditorSurface } from './tool-surface-guidance.js';

type PromptConstructorBaseOptions = {
  profile: ResolvedProfile;
  sandboxEnabled?: boolean;
  executionContext?: ExecutionContext;
  fileReadEnabled?: boolean;
  /** The profile has shell, but this read session withholds it because its sandbox cannot run. */
  shellWithheld?: boolean;
  /** False in a read session: a sandboxed shell may write only $TMPDIR. */
  workspaceWritable?: boolean;
  /** The root session can start background shell jobs that wake it on exit. */
  backgroundShellEnabled?: boolean;
};

export type PromptConstructorOptions = PromptConstructorBaseOptions &
  (
    | { runCodeEnabled: true; editorSurface: ScriptEditorSurface }
    | { runCodeEnabled?: false; editorSurface?: never }
    | { runCodeEnabled: boolean; editorSurface: ScriptEditorSurface }
  );

/** A read session without a working sandbox offers no shell (app/tool-surface.ts). */
const READ_ONLY_SHELL_UNAVAILABLE_INSTRUCTION =
  'Shell is unavailable in this read-only folder. Use the read, search, and list tools instead.';

export type PromptSpec = {
  basePromptContent: string;
  inlineSections: string[];
};

export function buildPromptSpec(options: PromptConstructorOptions): PromptSpec {
  const {
    profile,
    sandboxEnabled = true,
    executionContext,
    runCodeEnabled = false,
    editorSurface = 'none',
    fileReadEnabled = false,
    shellWithheld = false,
    workspaceWritable = true,
    backgroundShellEnabled = false,
  } = options;
  const shellOffered = runCodeEnabled && !shellWithheld;
  const inlineSections: string[] = [];
  if (sandboxEnabled && shellOffered && !executionContext?.isRemote()) {
    inlineSections.push(
      workspaceWritable
        ? 'Sandboxed shell writes are allowed only inside the workspace and $TMPDIR. Use $TMPDIR for scratch files.'
        : 'Sandboxed shell writes are allowed only inside $TMPDIR; the workspace is read-only. Use $TMPDIR for scratch files.',
    );
  }
  if (shellWithheld) {
    inlineSections.push(READ_ONLY_SHELL_UNAVAILABLE_INSTRUCTION);
  }
  // Bare is the only selectable built-in profile; it owns its prompt and only
  // concise capability guidance is added.
  if (profile.instructions.identity.kind !== 'markdown') {
    throw new Error(`Profile '${profile.identity.id}' has no prompt: only markdown identities are supported.`);
  }
  return {
    basePromptContent: renderBareToolGuidance(profile.instructions.identity.content, {
      fileReadEnabled,
      shellEnabled: shellOffered,
      backgroundShellEnabled: shellOffered && backgroundShellEnabled,
      editorSurface,
    }),
    inlineSections,
  };
}
