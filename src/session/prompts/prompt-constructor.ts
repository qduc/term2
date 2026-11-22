import type { ExecutionContext } from '../../tools/execution-context.js';
import type { ResolvedProfile } from '../../config/profiles/index.js';
import { renderBareToolGuidance } from './tool-surface-guidance.js';
import type { ScriptEditorSurface } from './tool-surface-guidance.js';

type PromptConstructorBaseOptions = {
  profile: ResolvedProfile;
  sandboxEnabled?: boolean;
  executionContext?: ExecutionContext;
  fileReadEnabled?: boolean;
};

export type PromptConstructorOptions = PromptConstructorBaseOptions &
  (
    | { runCodeEnabled: true; editorSurface: ScriptEditorSurface }
    | { runCodeEnabled?: false; editorSurface?: never }
    | { runCodeEnabled: boolean; editorSurface: ScriptEditorSurface }
  );

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
  } = options;
  // Bare is the only selectable built-in profile; it owns its prompt and only
  // concise capability guidance is added.
  if (profile.instructions.identity.kind !== 'markdown') {
    throw new Error(`Profile '${profile.identity.id}' has no prompt: only markdown identities are supported.`);
  }
  return {
    basePromptContent: renderBareToolGuidance(profile.instructions.identity.content, {
      fileReadEnabled,
      shellEnabled: runCodeEnabled,
      editorSurface,
    }),
    // Local shells always get $TMPDIR as Term2's scratch directory; an SSH host's TMPDIR is its own
    // (headless-approval-redesign.md, decision 4).
    inlineSections:
      runCodeEnabled && !executionContext?.isRemote()
        ? [
            sandboxEnabled
              ? 'Sandboxed shell writes are allowed only inside the workspace and $TMPDIR. Use $TMPDIR for scratch files.'
              : 'Use $TMPDIR for scratch files; plain /tmp is outside the workspace and writing there needs approval.',
          ]
        : [],
  };
}
