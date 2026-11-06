import type {
  BackPolicy,
  EditorSnapshot,
  FrameId,
  FrameSpec,
  MenuEffect,
  MenuFrame,
  MenuState,
  TextBinding,
} from './menu-types.js';
import { reconcileEditorTriggers, type TriggerRuleRegistry } from './editor-triggers.js';

function backPolicyFor(frame: MenuFrame): BackPolicy | undefined {
  if (frame.kind === 'settings_value' || frame.kind === 'subagent_pool') return frame.origin.back;
  if (frame.kind === 'model') return frame.back;
  return undefined;
}

function identityFromActivation(activationId: string): string {
  const separator = activationId.lastIndexOf(':');
  return separator === -1 ? activationId : activationId.slice(0, separator);
}

function refreshTopBinding(stack: MenuFrame[], editor: EditorSnapshot): void {
  const top = stack.at(-1);
  if (!top || !('binding' in top)) return;
  stack[stack.length - 1] = {
    ...top,
    binding: {
      ...top.binding,
      query: editor.text.slice(top.binding.queryStart, editor.cursor),
      revision: editor.revision,
    },
  } as MenuFrame;
}

/** Close one frame with its editor return policy, preserving the parent binding and dismissal identity. */
export function closeMenuFrame(state: MenuState): MenuState {
  const top = state.stack.at(-1);
  if (!top) return state;
  let editor = state.editor;
  let stack = [...state.stack.slice(0, -1)];
  const back = backPolicyFor(top);
  if (top.kind === 'providers' || top.kind === 'mcp') {
    editor = { ...top.returnPoint.editor, revision: editor.revision + 1 };
  } else if (back?.type === 'restore') {
    editor = { ...back.point.editor, revision: editor.revision + 1 };
  } else if (back?.type === 'close-clear-input') {
    editor = { text: '', cursor: 0, revision: editor.revision + 1 };
    stack = stack.filter((frame) => !('binding' in frame));
  }
  refreshTopBinding(stack, editor);
  const parent = stack.at(-1);
  const resolvedCandidateIdentity =
    parent && 'binding' in parent
      ? identityFromActivation(parent.binding.activationId)
      : back?.type === 'close-clear-input'
      ? null
      : 'binding' in top
      ? identityFromActivation(top.binding.activationId)
      : state.resolvedCandidateIdentity;
  return {
    ...state,
    editor,
    stack,
    resolvedCandidateIdentity,
    dismissedActivation: 'binding' in top ? top.binding.activationId : state.dismissedActivation,
  };
}

/** Apply an already validated menu effect atomically to editor and stack. No listeners or intents run here. */
export function applyMenuEffect(
  state: MenuState,
  effect: MenuEffect,
  registry: TriggerRuleRegistry,
  generateFrameId: () => FrameId,
): MenuState {
  const top = state.stack.at(-1)!;
  let { text, cursor, revision } = state.editor;
  const appliesBackPolicy = effect.stack.type === 'close-top' && (!effect.buffer || effect.buffer.type === 'keep');
  const back = appliesBackPolicy ? backPolicyFor(top) : undefined;
  let buffer = effect.buffer;
  if ((top.kind === 'providers' || top.kind === 'mcp') && appliesBackPolicy) {
    buffer = { type: 'replace', text: top.returnPoint.editor.text, cursor: top.returnPoint.editor.cursor };
  } else if (back?.type === 'restore') {
    buffer = { type: 'replace', text: back.point.editor.text, cursor: back.point.editor.cursor };
  } else if (back?.type === 'close-clear-input') {
    buffer = { type: 'clear' };
  }
  if (buffer && buffer.type !== 'keep') {
    revision += 1;
    switch (buffer.type) {
      case 'clear':
        text = '';
        cursor = 0;
        break;
      case 'replace':
        text = buffer.text;
        cursor = Math.min(Math.max(0, buffer.cursor), text.length);
        break;
      case 'splice':
        text = text.slice(0, buffer.range.start) + buffer.text + text.slice(buffer.range.end);
        cursor = buffer.range.start + buffer.text.length;
        break;
    }
  }
  cursor = Math.min(Math.max(0, cursor), text.length);
  const editor = { text, cursor, revision };
  let stack = [...state.stack];
  let resolvedCandidateIdentity = state.resolvedCandidateIdentity;
  let activationEpoch = state.activationEpoch;

  const createFrame = (spec: FrameSpec): MenuFrame => {
    let binding: TextBinding | undefined;
    if (spec.binding) {
      const parsed = registry.parse(editor);
      const identity = parsed?.candidate.frame.kind === spec.kind ? parsed.candidate.identity : spec.kind;
      activationEpoch += 1;
      resolvedCandidateIdentity = identity;
      binding = {
        ...spec.binding,
        query: editor.text.slice(spec.binding.queryStart, editor.cursor),
        activationId: `${identity}:${activationEpoch}`,
        revision: editor.revision,
      };
    }
    return { ...spec, id: generateFrameId(), ...(binding ? { binding } : {}) } as MenuFrame;
  };
  switch (effect.stack.type) {
    case 'keep':
      break;
    case 'close-top': {
      stack.pop();
      if (back?.type === 'close-clear-input') {
        stack = stack.filter((frame) => !('binding' in frame));
        resolvedCandidateIdentity = null;
      } else {
        const parent = stack.at(-1);
        resolvedCandidateIdentity =
          parent && 'binding' in parent
            ? identityFromActivation(parent.binding.activationId)
            : 'binding' in top
            ? identityFromActivation(top.binding.activationId)
            : resolvedCandidateIdentity;
      }
      break;
    }
    case 'close-all':
      stack = [];
      resolvedCandidateIdentity = effect.buffer?.type === 'clear' ? null : resolvedCandidateIdentity;
      break;
    case 'push':
      stack.push(createFrame(effect.stack.frame));
      break;
    case 'replace-top':
      stack.pop();
      stack.push(createFrame(effect.stack.frame));
      break;
    case 'pop-to': {
      const targetFrameId = effect.stack.frameId;
      const target = stack.findIndex((frame) => frame.id === targetFrameId);
      if (target !== -1) {
        stack = stack.slice(0, target + 1);
        const parent = stack.at(-1);
        resolvedCandidateIdentity =
          parent && 'binding' in parent
            ? identityFromActivation(parent.binding.activationId)
            : resolvedCandidateIdentity;
      }
      break;
    }
  }
  const removedActivation = effect.stack.type === 'close-top' && 'binding' in top ? top.binding.activationId : null;
  const dismissedActivation = removedActivation ?? state.dismissedActivation;
  // Explicit child/parent transitions must not be replaced by trigger parsing.
  if (effect.stack.type === 'keep') {
    const reconciled = reconcileEditorTriggers(
      { editor, stack, resolvedCandidateIdentity, activationEpoch, dismissedActivation: state.dismissedActivation },
      registry,
      generateFrameId,
    );
    return { ...reconciled, dismissedActivation };
  }
  refreshTopBinding(stack, editor);
  return { editor, stack, resolvedCandidateIdentity, activationEpoch, dismissedActivation };
}
