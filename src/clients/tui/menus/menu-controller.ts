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
  IntentHost,
  MenuInteraction,
  MenuInteractionRegistry,
  MenuState,
  OpenOptions,
  TextBinding,
  UnboundFrameSpec,
} from './menu-types.js';
import { reconcileEditorTriggers, TriggerRuleRegistry } from './editor-triggers.js';
import { applyMenuEffect, closeMenuFrame } from './frame-transitions.js';
export { TriggerRuleRegistry } from './editor-triggers.js';

function createInteractionRegistry(): MenuInteractionRegistry {
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

  public getInteractionRegistry(): MenuInteractionRegistry {
    return this.interactionRegistry;
  }

  public setTriggerRegistry(registry: TriggerRuleRegistry): void {
    this.triggerRegistry = registry;
    const next = reconcileEditorTriggers(this.state, this.triggerRegistry, () => this.generateFrameId());
    if (
      next.stack === this.state.stack &&
      next.resolvedCandidateIdentity === this.state.resolvedCandidateIdentity &&
      next.activationEpoch === this.state.activationEpoch &&
      next.dismissedActivation === this.state.dismissedActivation
    ) {
      return;
    }
    this.state = next;
  }

  public setIntentHost(host?: IntentHost): void {
    this.intentHost = host;
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

    this.state = reconcileEditorTriggers({ ...this.state, editor: nextEditor }, this.triggerRegistry, () =>
      this.generateFrameId(),
    );

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

    this.state = applyMenuEffect(this.state, effect, this.triggerRegistry, () => this.generateFrameId());

    this.notify();

    if (effect.intent && this.intentHost) {
      Promise.resolve(this.intentHost({ intentRequest: effect.intent }))
        .then((result) => {
          if (!result) return;
          const sourceFrame = this.state.stack.at(-1);
          if (!sourceFrame || sourceFrame.id !== result.sourceFrameId) return;

          const interactionResult = this.interactionRegistry.dispatch(result.sourceFrameId, result);
          if (interactionResult && typeof interactionResult === 'object' && 'stack' in interactionResult) {
            this.dispatch(interactionResult as MenuEffect, {
              frameId: result.sourceFrameId,
              revision: 'binding' in sourceFrame ? sourceFrame.binding.revision : this.state.editor.revision,
            });
          }
        })
        .catch(() => {});
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

    // A slash/settings interaction may not have registered its effect yet
    // when the first Escape arrives during the InputBox -> MenuSurface
    // handoff. Keep root-trigger cancellation at the controller boundary so
    // this transition cannot leave the command in the editor.
    const clearsRootTrigger = topFrame.kind === 'slash' || topFrame.kind === 'settings';
    const effect: MenuEffect = clearsRootTrigger
      ? { stack: { type: 'close-top' }, buffer: { type: 'clear' } }
      : { stack: { type: 'close-top' } };

    // Default escape behavior is still a controller transition, so child
    // BackPolicy and provider return-point behavior are applied uniformly.
    this.dispatch(effect, {
      frameId: topFrame.id,
      revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
    });
  }

  public open(unboundFrame: UnboundFrameSpec, options?: OpenOptions): void {
    let editor = { ...this.state.editor };

    if (options?.preserveEditorAsReturnPoint || unboundFrame.kind === 'providers' || unboundFrame.kind === 'mcp') {
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

    if (unboundFrame.kind === 'providers' || unboundFrame.kind === 'mcp') {
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
    let activationEpoch = this.state.activationEpoch;
    let resolvedCandidateIdentity = this.state.resolvedCandidateIdentity;
    if (frameSpec.binding) {
      const parsed = this.triggerRegistry.parse(editor);
      const identity = parsed?.candidate.frame.kind === frameSpec.kind ? parsed.candidate.identity : frameSpec.kind;
      activationEpoch += 1;
      resolvedCandidateIdentity = identity;
      const activationId = `${identity}:${activationEpoch}`;
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
      resolvedCandidateIdentity,
      activationEpoch,
    };

    this.notify();
  }

  public close(): void {
    if (this.state.stack.length === 0) return;

    const topFrame = this.state.stack.at(-1);
    if (!topFrame) return;
    this.state = closeMenuFrame(this.state);

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
