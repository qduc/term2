import type {
  EditorEdit,
  EditorSnapshot,
  ExpectedFrame,
  FrameId,
  FrameSpec,
  IntentResult,
  MenuController,
  MenuEffect,
  MenuEvent,
  MenuFrame,
  MenuInteraction,
  MenuInteractionRegistry,
  MenuState,
  OpenOptions,
  TextBinding,
  TriggerCandidate,
  TriggerRule,
  UnboundFrameSpec,
} from './menu-types.js';

export function createInteractionRegistry(): MenuInteractionRegistry {
  const interactions = new Map<FrameId, MenuInteraction>();

  return {
    register(frameId: FrameId, interaction: MenuInteraction) {
      interactions.set(frameId, interaction);
      return () => {
        if (interactions.get(frameId) === interaction) {
          interactions.delete(frameId);
        }
      };
    },
    dispatch(frameId: FrameId, event: MenuEvent | IntentResult) {
      const interaction = interactions.get(frameId);
      if (!interaction) return;
      return interaction.handle(event);
    },
  };
}

export class TriggerRuleRegistry {
  private rules: TriggerRule[] = [];

  public registerRule(rule: TriggerRule): void {
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new Error(`Duplicate trigger rule id: ${rule.id}`);
    }
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  public getRules(): readonly TriggerRule[] {
    return this.rules;
  }

  public parse(editor: EditorSnapshot): { rule: TriggerRule; candidate: TriggerCandidate } | null {
    for (const rule of this.rules) {
      const candidate = rule.parse(editor);
      if (candidate) {
        return { rule, candidate };
      }
    }
    return null;
  }

  public getRule(id: string): TriggerRule | undefined {
    return this.rules.find((r) => r.id === id);
  }
}

export type IntentHost = (event: {
  intentRequest: NonNullable<MenuEffect['intent']>;
}) => Promise<IntentResult> | IntentResult | void;

export class MenuControllerImpl implements MenuController {
  private state: MenuState;
  private listeners = new Set<() => void>();
  private interactionRegistry: MenuInteractionRegistry;
  private triggerRegistry: TriggerRuleRegistry;
  private intentHost?: IntentHost;
  private nextFrameId = 1;

  constructor(options?: {
    initialText?: string;
    initialCursor?: number;
    triggerRegistry?: TriggerRuleRegistry;
    interactionRegistry?: MenuInteractionRegistry;
    intentHost?: IntentHost;
  }) {
    const text = options?.initialText ?? '';
    const cursor = Math.min(Math.max(0, options?.initialCursor ?? text.length), text.length);

    this.state = {
      editor: {
        text,
        cursor,
        revision: 1,
      },
      stack: [],
      resolvedCandidateIdentity: null,
      activationEpoch: 0,
      dismissedActivation: null,
    };

    this.triggerRegistry = options?.triggerRegistry ?? new TriggerRuleRegistry();
    this.interactionRegistry = options?.interactionRegistry ?? createInteractionRegistry();
    this.intentHost = options?.intentHost;
  }

  public getSnapshot(): MenuState {
    return this.state;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private generateFrameId(): FrameId {
    return `frame-${this.nextFrameId++}`;
  }

  private computeBinding(
    candidate: TriggerCandidate,
    editor: EditorSnapshot,
    activationId: string,
  ): TextBinding {
    const spec = candidate.frame.binding;
    const queryStart = spec?.queryStart ?? candidate.frame.binding?.trigger.range.start ?? 0;
    const queryEnd = 'cursor' as const;
    const query = editor.text.slice(queryStart, editor.cursor);

    return {
      trigger: spec?.trigger ?? {
        range: { start: 0, end: editor.cursor },
        text: editor.text.slice(0, editor.cursor),
      },
      queryStart,
      queryEnd,
      query,
      replacement: spec?.replacement ?? {
        start: spec?.trigger.range.start ?? 0,
        end: 'cursor',
      },
      activationId,
      revision: editor.revision,
    };
  }

  private reconcileTriggers(
    editor: EditorSnapshot,
    stack: readonly MenuFrame[],
    prevCandidateIdentity: string | null,
    epoch: number,
    dismissedActivation: string | null,
  ): {
    nextStack: readonly MenuFrame[];
    nextCandidateIdentity: string | null;
    nextEpoch: number;
    nextDismissedActivation: string | null;
  } {
    const topFrame = stack.at(-1);

    // Explicitly opened frames ignore text trigger reconciliation until closed
    if (topFrame && (topFrame.kind === 'rewind' || topFrame.kind === 'providers')) {
      return {
        nextStack: stack,
        nextCandidateIdentity: prevCandidateIdentity,
        nextEpoch: epoch,
        nextDismissedActivation: dismissedActivation,
      };
    }

    const match = this.triggerRegistry.parse(editor);

    if (!match) {
      // Trigger candidate cleared
      const nextStack = topFrame && 'binding' in topFrame ? stack.slice(0, -1) : stack;
      return {
        nextStack,
        nextCandidateIdentity: null,
        nextEpoch: epoch,
        nextDismissedActivation: dismissedActivation,
      };
    }

    const { candidate } = match;
    const isSameCandidate = candidate.identity === prevCandidateIdentity;

    if (isSameCandidate) {
      const currentActivationId = `${candidate.identity}:${epoch}`;
      if (currentActivationId === dismissedActivation) {
        // Dismissed activation remains closed
        const nextStack = topFrame && 'binding' in topFrame ? stack.slice(0, -1) : stack;
        return {
          nextStack,
          nextCandidateIdentity: prevCandidateIdentity,
          nextEpoch: epoch,
          nextDismissedActivation: dismissedActivation,
        };
      }

      // Update existing frame binding with new revision and query
      if (topFrame && 'binding' in topFrame) {
        const updatedBinding = this.computeBinding(candidate, editor, currentActivationId);
        const updatedFrame = { ...topFrame, binding: updatedBinding } as MenuFrame;
        const nextStack = [...stack.slice(0, -1), updatedFrame];
        return {
          nextStack,
          nextCandidateIdentity: prevCandidateIdentity,
          nextEpoch: epoch,
          nextDismissedActivation: dismissedActivation,
        };
      }
    }

    // Candidate changed or newly appeared
    const nextEpoch = epoch + 1;
    const activationId = `${candidate.identity}:${nextEpoch}`;

    // Check successor relationship if top frame exists and has binding
    if (topFrame && 'binding' in topFrame) {
      const binding = this.computeBinding(candidate, editor, activationId);
      const newFrame = {
        ...candidate.frame,
        id: this.generateFrameId(),
        binding,
      } as MenuFrame;

      if (topRule && topRule.successors.some((s) => s.ruleId === candidate.ruleId)) {
        const successorOp = topRule.successors.find((s) => s.ruleId === candidate.ruleId);
        if (successorOp?.operation === 'push') {
          return {
            nextStack: [...stack, newFrame],
            nextCandidateIdentity: candidate.identity,
            nextEpoch,
            nextDismissedActivation: dismissedActivation,
          };
        } else {
          return {
            nextStack: [...stack.slice(0, -1), newFrame],
            nextCandidateIdentity: candidate.identity,
            nextEpoch,
            nextDismissedActivation: dismissedActivation,
          };
        }
      } else {
        // Unrelated candidate change: replace or open top frame
        return {
          nextStack: [...stack.slice(0, -1), newFrame],
          nextCandidateIdentity: candidate.identity,
          nextEpoch,
          nextDismissedActivation: dismissedActivation,
        };
      }
    }

    // No existing text frame: open new frame
    const binding = this.computeBinding(candidate, editor, activationId);
    const newFrame = {
      ...candidate.frame,
      id: this.generateFrameId(),
      binding,
    } as MenuFrame;

    return {
      nextStack: [...stack, newFrame],
      nextCandidateIdentity: candidate.identity,
      nextEpoch,
      nextDismissedActivation: dismissedActivation,
    };
  }

  public applyEditorEdit(edit: EditorEdit): void {
    let { text, cursor, revision } = this.state.editor;
    revision += 1;

    switch (edit.type) {
      case 'set-text':
        text = edit.text;
        cursor = edit.cursor ?? text.length;
        break;
      case 'insert': {
        const before = text.slice(0, cursor);
        const after = text.slice(cursor);
        text = before + edit.text + after;
        cursor += edit.text.length;
        break;
      }
      case 'move-cursor':
        cursor = edit.cursor;
        break;
    }

    cursor = Math.min(Math.max(0, cursor), text.length);
    const nextEditor: EditorSnapshot = { text, cursor, revision };

    const reconciled = this.reconcileTriggers(
      nextEditor,
      this.state.stack,
      this.state.resolvedCandidateIdentity,
      this.state.activationEpoch,
      this.state.dismissedActivation,
    );

    this.state = {
      editor: nextEditor,
      stack: reconciled.nextStack,
      resolvedCandidateIdentity: reconciled.nextCandidateIdentity,
      activationEpoch: reconciled.nextEpoch,
      dismissedActivation: reconciled.nextDismissedActivation,
    };

    this.notify();
  }

  public replaceText(text: string, cursor?: number): void {
    this.applyEditorEdit({ type: 'set-text', text, cursor });
  }

  public clearText(): void {
    this.applyEditorEdit({ type: 'set-text', text: '', cursor: 0 });
  }

  public dispatch(effect: MenuEffect, expected: ExpectedFrame): void {
    const topFrame = this.state.stack.at(-1);
    if (!topFrame || topFrame.id !== expected.frameId) {
      // Stale frame
      return;
    }

    if ('binding' in topFrame && topFrame.binding.revision !== expected.revision) {
      // Stale revision
      return;
    }

    let { text, cursor, revision } = this.state.editor;

    if (effect.buffer && effect.buffer.type !== 'keep') {
      revision += 1;

      switch (effect.buffer.type) {
        case 'clear':
          text = '';
          cursor = 0;
          break;
        case 'replace':
          text = effect.buffer.text;
          cursor = Math.min(Math.max(0, effect.buffer.cursor), text.length);
          break;
        case 'splice': {
          const { range, text: insertText } = effect.buffer;
          const before = text.slice(0, range.start);
          const after = text.slice(range.end);
          text = before + insertText + after;
          cursor = range.start + insertText.length;
          break;
        }
      }
    }

    cursor = Math.min(Math.max(0, cursor), text.length);
    const nextEditor: EditorSnapshot = { text, cursor, revision };

    let nextStack: MenuFrame[] = [...this.state.stack];

    switch (effect.stack.type) {
      case 'keep':
        break;
      case 'close-top':
        nextStack.pop();
        break;
      case 'close-all':
        nextStack = [];
        break;
      case 'push': {
        const frameSpec = effect.stack.frame;
        let binding: TextBinding | undefined = undefined;
        if (frameSpec.binding) {
          const activationId = `${this.state.resolvedCandidateIdentity ?? 'manual'}:${this.state.activationEpoch + 1}`;
          const query = nextEditor.text.slice(
            frameSpec.binding.queryStart,
            nextEditor.cursor,
          );
          binding = {
            ...frameSpec.binding,
            query,
            activationId,
            revision: nextEditor.revision,
          };
        }
        const newFrame = {
          ...frameSpec,
          id: this.generateFrameId(),
          ...(binding ? { binding } : {}),
        } as MenuFrame;
        nextStack.push(newFrame);
        break;
      }
      case 'replace-top': {
        nextStack.pop();
        const frameSpec = effect.stack.frame;
        let binding: TextBinding | undefined = undefined;
        if (frameSpec.binding) {
          const activationId = `${this.state.resolvedCandidateIdentity ?? 'manual'}:${this.state.activationEpoch + 1}`;
          const query = nextEditor.text.slice(
            frameSpec.binding.queryStart,
            nextEditor.cursor,
          );
          binding = {
            ...frameSpec.binding,
            query,
            activationId,
            revision: nextEditor.revision,
          };
        }
        const newFrame = {
          ...frameSpec,
          id: this.generateFrameId(),
          ...(binding ? { binding } : {}),
        } as MenuFrame;
        nextStack.push(newFrame);
        break;
      }
      case 'pop-to': {
        const targetFrameId = effect.stack.frameId;
        const targetIndex = nextStack.findIndex((f) => f.id === targetFrameId);
        if (targetIndex !== -1) {
          nextStack = nextStack.slice(0, targetIndex + 1);
        }
        break;
      }
    }

    const reconciled = this.reconcileTriggers(
      nextEditor,
      nextStack,
      this.state.resolvedCandidateIdentity,
      this.state.activationEpoch,
      this.state.dismissedActivation,
    );

    this.state = {
      editor: nextEditor,
      stack: reconciled.nextStack,
      resolvedCandidateIdentity: reconciled.nextCandidateIdentity,
      activationEpoch: reconciled.nextEpoch,
      dismissedActivation: reconciled.nextDismissedActivation,
    };

    this.notify();

    if (effect.intent && this.intentHost) {
      Promise.resolve(this.intentHost({ intentRequest: effect.intent })).catch(() => {});
    }
  }

  public dispatchActiveEvent(event: MenuEvent): void {
    const topFrame = this.state.stack.at(-1);
    if (!topFrame) return;

    const result = this.interactionRegistry.dispatch(topFrame.id, event);
    if (result && typeof result === 'object' && 'stack' in result) {
      const expected: ExpectedFrame = {
        frameId: topFrame.id,
        revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
      };
      this.dispatch(result as MenuEffect, expected);
    }
  }

  public escape(): void {
    const topFrame = this.state.stack.at(-1);
    if (!topFrame) return;

    const result = this.interactionRegistry.dispatch(topFrame.id, { type: 'escape' });
    if (result && typeof result === 'object' && 'stack' in result) {
      const expected: ExpectedFrame = {
        frameId: topFrame.id,
        revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
      };
      this.dispatch(result as MenuEffect, expected);
      return;
    }

    // Default escape behavior: close top frame and set dismissedActivation if text-bound
    const dismissedActivation = 'binding' in topFrame ? topFrame.binding.activationId : this.state.dismissedActivation;
    const nextStack = this.state.stack.slice(0, -1);

    this.state = {
      ...this.state,
      stack: nextStack,
      dismissedActivation,
    };

    this.notify();
  }

  public open(unboundFrame: UnboundFrameSpec, options?: OpenOptions): void {
    let editor = { ...this.state.editor };

    if (options?.preserveEditorAsReturnPoint || unboundFrame.kind === 'providers') {
      // returnPoint is captured editor
    }

    if (options?.buffer) {
      if (options.buffer.type === 'clear') {
        editor = { text: '', cursor: 0, revision: editor.revision + 1 };
      } else if (options.buffer.type === 'replace') {
        editor = {
          text: options.buffer.text,
          cursor: options.buffer.cursor,
          revision: editor.revision + 1,
        };
      }
    }

    const frameId = this.generateFrameId();
    let frame: MenuFrame;

    if (unboundFrame.kind === 'providers') {
      frame = {
        ...unboundFrame,
        id: frameId,
        returnPoint: { editor: this.state.editor },
      };
    } else {
      frame = {
        ...unboundFrame,
        id: frameId,
      };
    }

    this.state = {
      ...this.state,
      editor,
      stack: [...this.state.stack, frame],
    };

    this.notify();
  }

  public replace(frameSpec: FrameSpec, options?: OpenOptions): void {
    let editor = { ...this.state.editor };

    if (options?.buffer) {
      if (options.buffer.type === 'clear') {
        editor = { text: '', cursor: 0, revision: editor.revision + 1 };
      } else if (options.buffer.type === 'replace') {
        editor = {
          text: options.buffer.text,
          cursor: options.buffer.cursor,
          revision: editor.revision + 1,
        };
      }
    }

    const frameId = this.generateFrameId();
    let binding: TextBinding | undefined = undefined;
    if (frameSpec.binding) {
      const activationId = `${this.state.resolvedCandidateIdentity ?? 'manual'}:${this.state.activationEpoch + 1}`;
      const query = editor.text.slice(frameSpec.binding.queryStart, editor.cursor);
      binding = {
        ...frameSpec.binding,
        query,
        activationId,
        revision: editor.revision,
      };
    }

    const frame = {
      ...frameSpec,
      id: frameId,
      ...(binding ? { binding } : {}),
    } as MenuFrame;

    this.state = {
      ...this.state,
      editor,
      stack: [...this.state.stack.slice(0, -1), frame],
    };

    this.notify();
  }

  public close(): void {
    if (this.state.stack.length === 0) return;

    const topFrame = this.state.stack.at(-1);
    const dismissedActivation = topFrame && 'binding' in topFrame ? topFrame.binding.activationId : this.state.dismissedActivation;

    this.state = {
      ...this.state,
      stack: this.state.stack.slice(0, -1),
      dismissedActivation,
    };

    this.notify();
  }

  public closeAll(): void {
    this.state = {
      ...this.state,
      stack: [],
    };

    this.notify();
  }
}
