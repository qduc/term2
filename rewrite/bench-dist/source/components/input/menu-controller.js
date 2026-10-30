export function createInteractionRegistry() {
    const interactions = new Map();
    return {
        register(frameId, interaction) {
            interactions.set(frameId, interaction);
            return () => {
                if (interactions.get(frameId) === interaction) {
                    interactions.delete(frameId);
                }
            };
        },
        dispatch(frameId, event) {
            const interaction = interactions.get(frameId);
            if (!interaction)
                return;
            return interaction.handle(event);
        },
    };
}
export class TriggerRuleRegistry {
    rules = [];
    registerRule(rule) {
        if (this.rules.some((r) => r.id === rule.id)) {
            throw new Error(`Duplicate trigger rule id: ${rule.id}`);
        }
        this.rules.push(rule);
        this.rules.sort((a, b) => b.priority - a.priority);
    }
    getRules() {
        return this.rules;
    }
    parse(editor) {
        for (const rule of this.rules) {
            const candidate = rule.parse(editor);
            if (candidate) {
                return { rule, candidate };
            }
        }
        return null;
    }
    getRule(id) {
        return this.rules.find((r) => r.id === id);
    }
}
export class MenuControllerImpl {
    state;
    listeners = new Set();
    interactionRegistry;
    triggerRegistry;
    intentHost;
    nextFrameId = 1;
    constructor(options) {
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
    getSnapshot() {
        return this.state;
    }
    getInteractionRegistry() {
        return this.interactionRegistry;
    }
    setTriggerRegistry(registry) {
        this.triggerRegistry = registry;
        const reconciled = this.reconcileTriggers(this.state.editor, this.state.stack, this.state.resolvedCandidateIdentity, this.state.activationEpoch, this.state.dismissedActivation);
        if (reconciled.nextStack === this.state.stack &&
            reconciled.nextCandidateIdentity === this.state.resolvedCandidateIdentity &&
            reconciled.nextEpoch === this.state.activationEpoch &&
            reconciled.nextDismissedActivation === this.state.dismissedActivation) {
            return;
        }
        this.state = {
            ...this.state,
            stack: reconciled.nextStack,
            resolvedCandidateIdentity: reconciled.nextCandidateIdentity,
            activationEpoch: reconciled.nextEpoch,
            dismissedActivation: reconciled.nextDismissedActivation,
        };
    }
    setIntentHost(host) {
        this.intentHost = host;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    notify() {
        for (const listener of this.listeners) {
            listener();
        }
    }
    generateFrameId() {
        return `frame-${this.nextFrameId++}`;
    }
    backPolicyFor(frame) {
        if (frame?.kind === 'settings_value')
            return frame.origin.back;
        if (frame?.kind === 'subagent_pool')
            return frame.origin.back;
        if (frame?.kind === 'model')
            return frame.back;
        return undefined;
    }
    identityFromActivation(activationId) {
        const separator = activationId.lastIndexOf(':');
        return separator === -1 ? activationId : activationId.slice(0, separator);
    }
    refreshTopBinding(stack, editor) {
        const topFrame = stack.at(-1);
        if (!topFrame || !('binding' in topFrame))
            return;
        const binding = topFrame.binding;
        stack[stack.length - 1] = {
            ...topFrame,
            binding: {
                ...binding,
                query: editor.text.slice(binding.queryStart, editor.cursor),
                revision: editor.revision,
            },
        };
    }
    closeTopTransition(topFrame, editor, stack) {
        let nextEditor = editor;
        let nextStack = [...stack.slice(0, -1)];
        const back = this.backPolicyFor(topFrame);
        if (topFrame.kind === 'providers' || topFrame.kind === 'mcp') {
            nextEditor = {
                ...topFrame.returnPoint.editor,
                revision: editor.revision + 1,
            };
        }
        else if (back?.type === 'restore') {
            nextEditor = {
                ...back.point.editor,
                revision: editor.revision + 1,
            };
        }
        else if (back?.type === 'close-clear-input') {
            nextEditor = { text: '', cursor: 0, revision: editor.revision + 1 };
            // A cleared buffer cannot continue to support a bound parent frame.
            nextStack = nextStack.filter((frame) => !('binding' in frame));
        }
        this.refreshTopBinding(nextStack, nextEditor);
        const nextTop = nextStack.at(-1);
        if (nextTop && 'binding' in nextTop) {
            return {
                editor: nextEditor,
                stack: nextStack,
                candidateIdentity: this.identityFromActivation(nextTop.binding.activationId),
            };
        }
        if (back?.type === 'close-clear-input') {
            return { editor: nextEditor, stack: nextStack, candidateIdentity: null };
        }
        return {
            editor: nextEditor,
            stack: nextStack,
            candidateIdentity: topFrame && 'binding' in topFrame
                ? this.identityFromActivation(topFrame.binding.activationId)
                : this.state.resolvedCandidateIdentity,
        };
    }
    computeBinding(candidate, editor, activationId) {
        const spec = candidate.frame.binding;
        const queryStart = spec?.queryStart ?? candidate.frame.binding?.trigger.range.start ?? 0;
        const queryEnd = 'cursor';
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
    sameBinding(left, right) {
        return (left.trigger.text === right.trigger.text &&
            left.trigger.range.start === right.trigger.range.start &&
            left.trigger.range.end === right.trigger.range.end &&
            left.queryStart === right.queryStart &&
            left.queryEnd === right.queryEnd &&
            left.query === right.query &&
            left.replacement.start === right.replacement.start &&
            left.replacement.end === right.replacement.end &&
            left.activationId === right.activationId &&
            left.revision === right.revision);
    }
    reconcileTriggers(editor, stack, prevCandidateIdentity, epoch, dismissedActivation) {
        const topFrame = stack.at(-1);
        // Explicitly opened frames ignore text trigger reconciliation until closed
        if (topFrame &&
            (topFrame.kind === 'rewind' ||
                topFrame.kind === 'providers' ||
                topFrame.kind === 'mcp' ||
                topFrame.kind === 'subagent_pool')) {
            if (topFrame.kind === 'subagent_pool' && 'binding' in topFrame) {
                const binding = {
                    ...topFrame.binding,
                    query: editor.text.slice(topFrame.binding.queryStart, editor.cursor),
                    revision: editor.revision,
                };
                if (!this.sameBinding(topFrame.binding, binding)) {
                    return {
                        nextStack: [...stack.slice(0, -1), { ...topFrame, binding }],
                        nextCandidateIdentity: prevCandidateIdentity,
                        nextEpoch: epoch,
                        nextDismissedActivation: dismissedActivation,
                    };
                }
            }
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
            const currentActivationId = topFrame && 'binding' in topFrame ? topFrame.binding.activationId : `${candidate.identity}:${epoch}`;
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
                if (this.sameBinding(topFrame.binding, updatedBinding)) {
                    return {
                        nextStack: stack,
                        nextCandidateIdentity: prevCandidateIdentity,
                        nextEpoch: epoch,
                        nextDismissedActivation: dismissedActivation,
                    };
                }
                const updatedFrame = { ...topFrame, binding: updatedBinding };
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
            const topRule = this.triggerRegistry.getRules().find((r) => topFrame.kind === r.id);
            const binding = this.computeBinding(candidate, editor, activationId);
            const newFrame = {
                ...candidate.frame,
                id: this.generateFrameId(),
                binding,
            };
            if (topRule && topRule.successors.some((s) => s.ruleId === candidate.ruleId)) {
                const successorOp = topRule.successors.find((s) => s.ruleId === candidate.ruleId);
                if (successorOp?.operation === 'push') {
                    return {
                        nextStack: [...stack, newFrame],
                        nextCandidateIdentity: candidate.identity,
                        nextEpoch,
                        nextDismissedActivation: dismissedActivation,
                    };
                }
                else {
                    return {
                        nextStack: [...stack.slice(0, -1), newFrame],
                        nextCandidateIdentity: candidate.identity,
                        nextEpoch,
                        nextDismissedActivation: dismissedActivation,
                    };
                }
            }
            else {
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
        };
        return {
            nextStack: [...stack, newFrame],
            nextCandidateIdentity: candidate.identity,
            nextEpoch,
            nextDismissedActivation: dismissedActivation,
        };
    }
    applyEditorEdit(edit) {
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
        const nextEditor = { text, cursor, revision };
        const reconciled = this.reconcileTriggers(nextEditor, this.state.stack, this.state.resolvedCandidateIdentity, this.state.activationEpoch, this.state.dismissedActivation);
        this.state = {
            editor: nextEditor,
            stack: reconciled.nextStack,
            resolvedCandidateIdentity: reconciled.nextCandidateIdentity,
            activationEpoch: reconciled.nextEpoch,
            dismissedActivation: reconciled.nextDismissedActivation,
        };
        this.notify();
    }
    replaceText(text, cursor) {
        this.applyEditorEdit({ type: 'set-text', text, cursor });
    }
    clearText() {
        this.applyEditorEdit({ type: 'set-text', text: '', cursor: 0 });
    }
    dispatch(effect, expected) {
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
        const appliesBackPolicy = effect.stack.type === 'close-top' && (!effect.buffer || effect.buffer.type === 'keep');
        const backPolicy = appliesBackPolicy ? this.backPolicyFor(topFrame) : undefined;
        let buffer = effect.buffer;
        if ((topFrame?.kind === 'providers' || topFrame?.kind === 'mcp') && appliesBackPolicy) {
            buffer = {
                type: 'replace',
                text: topFrame.returnPoint.editor.text,
                cursor: topFrame.returnPoint.editor.cursor,
            };
        }
        else if (backPolicy?.type === 'restore') {
            buffer = { type: 'replace', text: backPolicy.point.editor.text, cursor: backPolicy.point.editor.cursor };
        }
        else if (backPolicy?.type === 'close-clear-input') {
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
                case 'splice': {
                    const { range, text: insertText } = buffer;
                    const before = text.slice(0, range.start);
                    const after = text.slice(range.end);
                    text = before + insertText + after;
                    cursor = range.start + insertText.length;
                    break;
                }
            }
        }
        cursor = Math.min(Math.max(0, cursor), text.length);
        const nextEditor = { text, cursor, revision };
        let nextStack = [...this.state.stack];
        let nextCandidateIdentity = this.state.resolvedCandidateIdentity;
        let nextEpoch = this.state.activationEpoch;
        switch (effect.stack.type) {
            case 'keep':
                break;
            case 'close-top':
                nextStack.pop();
                if (backPolicy?.type === 'close-clear-input') {
                    nextStack = nextStack.filter((frame) => !('binding' in frame));
                    nextCandidateIdentity = null;
                }
                else {
                    const nextTop = nextStack.at(-1);
                    nextCandidateIdentity =
                        nextTop && 'binding' in nextTop
                            ? this.identityFromActivation(nextTop.binding.activationId)
                            : topFrame && 'binding' in topFrame
                                ? this.identityFromActivation(topFrame.binding.activationId)
                                : nextCandidateIdentity;
                }
                break;
            case 'close-all':
                nextStack = [];
                nextCandidateIdentity = effect.buffer?.type === 'clear' ? null : nextCandidateIdentity;
                break;
            case 'push': {
                const frameSpec = effect.stack.frame;
                let binding = undefined;
                if (frameSpec.binding) {
                    const parsed = this.triggerRegistry.parse(nextEditor);
                    const identity = parsed?.candidate.frame.kind === frameSpec.kind ? parsed.candidate.identity : frameSpec.kind;
                    nextEpoch += 1;
                    nextCandidateIdentity = identity;
                    const activationId = `${identity}:${nextEpoch}`;
                    const query = nextEditor.text.slice(frameSpec.binding.queryStart, nextEditor.cursor);
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
                };
                nextStack.push(newFrame);
                break;
            }
            case 'replace-top': {
                nextStack.pop();
                const frameSpec = effect.stack.frame;
                let binding = undefined;
                if (frameSpec.binding) {
                    const parsed = this.triggerRegistry.parse(nextEditor);
                    const identity = parsed?.candidate.frame.kind === frameSpec.kind ? parsed.candidate.identity : frameSpec.kind;
                    nextEpoch += 1;
                    nextCandidateIdentity = identity;
                    const activationId = `${identity}:${nextEpoch}`;
                    const query = nextEditor.text.slice(frameSpec.binding.queryStart, nextEditor.cursor);
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
                };
                nextStack.push(newFrame);
                break;
            }
            case 'pop-to': {
                const targetFrameId = effect.stack.frameId;
                const targetIndex = nextStack.findIndex((f) => f.id === targetFrameId);
                if (targetIndex !== -1) {
                    nextStack = nextStack.slice(0, targetIndex + 1);
                    const nextTop = nextStack.at(-1);
                    nextCandidateIdentity =
                        nextTop && 'binding' in nextTop
                            ? this.identityFromActivation(nextTop.binding.activationId)
                            : nextCandidateIdentity;
                }
                break;
            }
        }
        const removedActivation = effect.stack.type === 'close-top' && 'binding' in topFrame ? topFrame.binding.activationId : null;
        const dismissedActivation = removedActivation ?? this.state.dismissedActivation;
        // A stack transition is already an authoritative child/parent transition.
        // Re-running trigger reconciliation here can replace the frame just pushed.
        if (effect.stack.type === 'keep') {
            const reconciled = this.reconcileTriggers(nextEditor, nextStack, nextCandidateIdentity, nextEpoch, this.state.dismissedActivation);
            nextStack = [...reconciled.nextStack];
            nextCandidateIdentity = reconciled.nextCandidateIdentity;
            nextEpoch = reconciled.nextEpoch;
        }
        else {
            this.refreshTopBinding(nextStack, nextEditor);
        }
        this.state = {
            editor: nextEditor,
            stack: nextStack,
            resolvedCandidateIdentity: nextCandidateIdentity,
            activationEpoch: nextEpoch,
            dismissedActivation,
        };
        this.notify();
        if (effect.intent && this.intentHost) {
            Promise.resolve(this.intentHost({ intentRequest: effect.intent }))
                .then((result) => {
                if (!result)
                    return;
                const sourceFrame = this.state.stack.at(-1);
                if (!sourceFrame || sourceFrame.id !== result.sourceFrameId)
                    return;
                const interactionResult = this.interactionRegistry.dispatch(result.sourceFrameId, result);
                if (interactionResult && typeof interactionResult === 'object' && 'stack' in interactionResult) {
                    this.dispatch(interactionResult, {
                        frameId: result.sourceFrameId,
                        revision: 'binding' in sourceFrame ? sourceFrame.binding.revision : this.state.editor.revision,
                    });
                }
            })
                .catch(() => { });
        }
    }
    dispatchActiveEvent(event) {
        const topFrame = this.state.stack.at(-1);
        if (!topFrame)
            return;
        const result = this.interactionRegistry.dispatch(topFrame.id, event);
        if (result && typeof result === 'object' && 'stack' in result) {
            const expected = {
                frameId: topFrame.id,
                revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
            };
            this.dispatch(result, expected);
        }
    }
    escape() {
        const topFrame = this.state.stack.at(-1);
        if (!topFrame)
            return;
        const result = this.interactionRegistry.dispatch(topFrame.id, { type: 'escape' });
        if (result && typeof result === 'object' && 'stack' in result) {
            const expected = {
                frameId: topFrame.id,
                revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
            };
            this.dispatch(result, expected);
            return;
        }
        // A slash/settings interaction may not have registered its effect yet
        // when the first Escape arrives during the InputBox -> MenuSurface
        // handoff. Keep root-trigger cancellation at the controller boundary so
        // this transition cannot leave the command in the editor.
        const clearsRootTrigger = topFrame.kind === 'slash' || topFrame.kind === 'settings';
        const effect = clearsRootTrigger
            ? { stack: { type: 'close-top' }, buffer: { type: 'clear' } }
            : { stack: { type: 'close-top' } };
        // Default escape behavior is still a controller transition, so child
        // BackPolicy and provider return-point behavior are applied uniformly.
        this.dispatch(effect, {
            frameId: topFrame.id,
            revision: 'binding' in topFrame ? topFrame.binding.revision : this.state.editor.revision,
        });
    }
    open(unboundFrame, options) {
        let editor = { ...this.state.editor };
        if (options?.preserveEditorAsReturnPoint || unboundFrame.kind === 'providers' || unboundFrame.kind === 'mcp') {
            // returnPoint is captured editor
        }
        if (options?.buffer) {
            if (options.buffer.type === 'clear') {
                editor = { text: '', cursor: 0, revision: editor.revision + 1 };
            }
            else if (options.buffer.type === 'replace') {
                editor = {
                    text: options.buffer.text,
                    cursor: options.buffer.cursor,
                    revision: editor.revision + 1,
                };
            }
        }
        const frameId = this.generateFrameId();
        let frame;
        if (unboundFrame.kind === 'providers' || unboundFrame.kind === 'mcp') {
            frame = {
                ...unboundFrame,
                id: frameId,
                returnPoint: { editor: this.state.editor },
            };
        }
        else {
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
    replace(frameSpec, options) {
        let editor = { ...this.state.editor };
        if (options?.buffer) {
            if (options.buffer.type === 'clear') {
                editor = { text: '', cursor: 0, revision: editor.revision + 1 };
            }
            else if (options.buffer.type === 'replace') {
                editor = {
                    text: options.buffer.text,
                    cursor: options.buffer.cursor,
                    revision: editor.revision + 1,
                };
            }
        }
        const frameId = this.generateFrameId();
        let binding = undefined;
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
        };
        this.state = {
            ...this.state,
            editor,
            stack: [...this.state.stack.slice(0, -1), frame],
            resolvedCandidateIdentity,
            activationEpoch,
        };
        this.notify();
    }
    close() {
        if (this.state.stack.length === 0)
            return;
        const topFrame = this.state.stack.at(-1);
        if (!topFrame)
            return;
        const transition = this.closeTopTransition(topFrame, this.state.editor, this.state.stack);
        const dismissedActivation = 'binding' in topFrame ? topFrame.binding.activationId : this.state.dismissedActivation;
        this.state = {
            ...this.state,
            editor: transition.editor,
            stack: transition.stack,
            resolvedCandidateIdentity: transition.candidateIdentity,
            dismissedActivation,
        };
        this.notify();
    }
    closeAll() {
        this.state = {
            ...this.state,
            stack: [],
        };
        this.notify();
    }
}
//# sourceMappingURL=menu-controller.js.map