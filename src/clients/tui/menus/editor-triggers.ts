import type {
  EditorSnapshot,
  FrameId,
  MenuFrame,
  MenuState,
  TextBinding,
  TriggerCandidate,
  TriggerRule,
} from './menu-types.js';

/** Ordered trigger rules shared by the controller and menu sessions. */
export class TriggerRuleRegistry {
  private rules: TriggerRule[] = [];

  public registerRule(rule: TriggerRule): void {
    if (this.rules.some((r) => r.id === rule.id)) throw new Error(`Duplicate trigger rule id: ${rule.id}`);
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  public getRules(): readonly TriggerRule[] {
    return this.rules;
  }

  public parse(editor: EditorSnapshot): { rule: TriggerRule; candidate: TriggerCandidate } | null {
    for (const rule of this.rules) {
      const candidate = rule.parse(editor);
      if (candidate) return { rule, candidate };
    }
    return null;
  }

  public getRule(id: string): TriggerRule | undefined {
    return this.rules.find((r) => r.id === id);
  }
}

function computeBinding(candidate: TriggerCandidate, editor: EditorSnapshot, activationId: string): TextBinding {
  const spec = candidate.frame.binding;
  const queryStart = spec?.queryStart ?? candidate.frame.binding?.trigger.range.start ?? 0;
  return {
    trigger: spec?.trigger ?? { range: { start: 0, end: editor.cursor }, text: editor.text.slice(0, editor.cursor) },
    queryStart,
    queryEnd: 'cursor',
    query: editor.text.slice(queryStart, editor.cursor),
    replacement: spec?.replacement ?? { start: spec?.trigger.range.start ?? 0, end: 'cursor' },
    activationId,
    revision: editor.revision,
  };
}

function sameBinding(left: TextBinding, right: TextBinding): boolean {
  return (
    left.trigger.text === right.trigger.text &&
    left.trigger.range.start === right.trigger.range.start &&
    left.trigger.range.end === right.trigger.range.end &&
    left.queryStart === right.queryStart &&
    left.queryEnd === right.queryEnd &&
    left.query === right.query &&
    left.replacement.start === right.replacement.start &&
    left.replacement.end === right.replacement.end &&
    left.activationId === right.activationId &&
    left.revision === right.revision
  );
}

/** Reconcile editor triggers without publishing state or taking keyboard ownership.
 * Explicit frames suppress parsing; dismissed activations stay closed until the candidate changes.
 */
export function reconcileEditorTriggers(
  state: MenuState,
  registry: TriggerRuleRegistry,
  generateFrameId: () => FrameId,
): MenuState {
  const {
    editor,
    stack,
    resolvedCandidateIdentity: previousIdentity,
    activationEpoch: epoch,
    dismissedActivation,
  } = state;
  const top = stack.at(-1);
  if (
    top &&
    (top.kind === 'rewind' || top.kind === 'providers' || top.kind === 'mcp' || top.kind === 'subagent_pool')
  ) {
    if (top.kind === 'subagent_pool' && 'binding' in top) {
      const binding = {
        ...top.binding,
        query: editor.text.slice(top.binding.queryStart, editor.cursor),
        revision: editor.revision,
      };
      if (!sameBinding(top.binding, binding)) return { ...state, stack: [...stack.slice(0, -1), { ...top, binding }] };
    }
    return state;
  }

  const match = registry.parse(editor);
  if (!match) {
    return { ...state, stack: top && 'binding' in top ? stack.slice(0, -1) : stack, resolvedCandidateIdentity: null };
  }

  const { candidate } = match;
  if (candidate.identity === previousIdentity) {
    const activationId = top && 'binding' in top ? top.binding.activationId : `${candidate.identity}:${epoch}`;
    if (activationId === dismissedActivation) {
      return { ...state, stack: top && 'binding' in top ? stack.slice(0, -1) : stack };
    }
    if (top && 'binding' in top) {
      const binding = computeBinding(candidate, editor, activationId);
      if (sameBinding(top.binding, binding)) return state;
      return { ...state, stack: [...stack.slice(0, -1), { ...top, binding } as MenuFrame] };
    }
  }

  const activationEpoch = epoch + 1;
  const frame = {
    ...candidate.frame,
    id: generateFrameId(),
    binding: computeBinding(candidate, editor, `${candidate.identity}:${activationEpoch}`),
  } as MenuFrame;
  const topRule = top && 'binding' in top ? registry.getRules().find((r) => top.kind === r.id) : undefined;
  const successor = topRule?.successors.find((s) => s.ruleId === candidate.ruleId);
  const parentStack = top && 'binding' in top && successor?.operation !== 'push' ? stack.slice(0, -1) : stack;
  return { ...state, stack: [...parentStack, frame], resolvedCandidateIdentity: candidate.identity, activationEpoch };
}
