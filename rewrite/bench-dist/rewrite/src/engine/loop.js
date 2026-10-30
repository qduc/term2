let nextId = 0;
const itemId = () => `item_${Date.now().toString(36)}_e${(nextId++).toString(36)}`;
/**
 * The turn loop: call the model, run the tool calls it asks for, repeat.
 *
 * Every step boundary emits a `checkpoint`. A tool that needs approval ends
 * the run as `suspended`; `resume` picks up from that checkpoint with the
 * decisions. Nothing here calls into a UI or writes storage.
 */
export const createEngine = (deps) => {
    const controllers = new Set();
    return {
        start: (input) => run(deps, { turnId: input.turnId, input, produced: [], pendingCalls: [], modelCalls: 0 }, new Map(), controllers),
        resume: (checkpoint, decisions) => run(deps, checkpoint, decisions, controllers),
        dispose: async () => {
            for (const controller of controllers)
                controller.abort();
            controllers.clear();
        },
    };
};
function run(deps, from, decisions, controllers) {
    const controller = new AbortController();
    controllers.add(controller);
    return {
        turnId: from.turnId,
        events: (async function* () {
            try {
                yield* loop(deps, from, decisions, controller.signal);
            }
            finally {
                controllers.delete(controller);
            }
        })(),
        cancel: () => controller.abort(),
    };
}
async function* loop(deps, from, decisions, signal) {
    const { input } = from;
    if (input.budget.kind === 'adopted') {
        yield {
            type: 'turn_ended',
            outcome: {
                kind: 'failed',
                error: { kind: 'invalid_request', message: 'Adopted budget requires the adopted engine', retryable: false },
            },
        };
        return;
    }
    const produced = [...from.produced];
    let pending = [...from.pendingCalls];
    let modelCalls = from.modelCalls;
    let continuation = from.continuation;
    const checkpoint = () => ({
        turnId: input.turnId,
        input,
        produced: [...produced],
        pendingCalls: [...pending],
        modelCalls,
        ...(continuation === undefined ? {} : { continuation }),
    });
    while (true) {
        if (signal.aborted)
            return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
        if (pending.length > 0) {
            const ask = await askFor(deps, input, pending, decisions, signal);
            if (signal.aborted)
                return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
            if (ask.length > 0) {
                return yield { type: 'turn_ended', outcome: { kind: 'suspended', approvals: ask, checkpoint: checkpoint() } };
            }
            for (const call of [...pending]) {
                yield { type: 'tool_started', callId: call.callId, toolName: call.toolName, input: call.input };
                // Progress is buffered until the tool returns; live streaming needs a channel, not a generator.
                const progress = [];
                const result = await executeCall(deps, input, call, decisions.get(call.callId), signal, (chunk) => {
                    progress.push({ type: 'tool_progress', callId: call.callId, chunk });
                });
                if (signal.aborted)
                    return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
                yield* progress;
                yield { type: 'tool_finished', callId: call.callId, result };
                const item = {
                    type: 'tool_result',
                    id: itemId(),
                    callId: call.callId,
                    output: result.output,
                    isError: result.isError,
                    ...(result.providerOutput ? { providerOutput: result.providerOutput } : {}),
                };
                produced.push(item);
                pending = pending.filter((candidate) => candidate.callId !== call.callId);
                yield { type: 'item', item };
                yield { type: 'checkpoint', checkpoint: checkpoint() };
            }
        }
        if (modelCalls >= input.budget.maxModelCalls) {
            return yield { type: 'turn_ended', outcome: { kind: 'budget_exhausted' } };
        }
        const model = deps.models.resolve(input.model);
        const tools = input.toolNames.flatMap((name) => {
            const tool = deps.tools.get(name);
            return tool ? [tool.spec] : [];
        });
        modelCalls += 1;
        try {
            for await (const event of model.stream({
                model: input.model,
                instructions: input.instructions,
                input: [...input.history, ...input.newItems, ...produced],
                tools,
                ...(input.reasoning ? { reasoning: input.reasoning } : {}),
                ...(continuation === undefined ? {} : { continuation }),
            }, signal)) {
                switch (event.type) {
                    case 'item':
                        produced.push(event.item);
                        if (event.item.type === 'tool_call') {
                            pending.push({ callId: event.item.callId, toolName: event.item.toolName, input: event.item.input });
                        }
                        yield { type: 'item', item: event.item };
                        break;
                    case 'done':
                        continuation = event.continuation;
                        break;
                    default:
                        yield event;
                }
            }
        }
        catch (error) {
            if (signal.aborted)
                return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
            const message = error instanceof Error ? error.message : String(error);
            return yield {
                type: 'turn_ended',
                outcome: { kind: 'failed', error: { kind: 'provider', message, retryable: false } },
            };
        }
        if (pending.length === 0)
            return yield { type: 'turn_ended', outcome: { kind: 'completed' } };
        yield { type: 'checkpoint', checkpoint: checkpoint() };
    }
}
function toolContext(deps, input) {
    return {
        workspace: input.workspace,
        settings: deps.settings,
        runNested: async () => {
            throw new Error('Nested runs are unavailable');
        },
    };
}
async function askFor(deps, input, pending, decisions, signal) {
    const ctx = { ...toolContext(deps, input), signal, progress: () => { } };
    const requests = [];
    for (const call of pending) {
        if (decisions.has(call.callId))
            continue;
        const tool = deps.tools.get(call.toolName);
        if (!tool)
            continue;
        let requirement;
        try {
            requirement = await tool.approval(tool.parse(call.input), ctx);
        }
        catch {
            continue;
        }
        if (requirement.kind === 'ask')
            requests.push({ callId: call.callId, toolName: call.toolName, requirement });
    }
    return requests;
}
async function executeCall(deps, input, call, decision, signal, progress) {
    const tool = deps.tools.get(call.toolName);
    if (!tool)
        return { output: `unknown tool "${call.toolName}"`, isError: true };
    if (decision?.kind === 'reject') {
        return { output: `the user rejected this call${decision.reason ? `: ${decision.reason}` : ''}`, isError: true };
    }
    const ctx = { ...toolContext(deps, input), signal, progress };
    try {
        const parsed = tool.parse(call.input);
        const requirement = await tool.approval(parsed, ctx);
        if (signal.aborted)
            return { output: 'Operation aborted', isError: true };
        if (requirement.kind === 'deny')
            return { output: `denied: ${requirement.reason}`, isError: true };
        return await tool.execute(parsed, ctx);
    }
    catch (error) {
        return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
}
//# sourceMappingURL=loop.js.map