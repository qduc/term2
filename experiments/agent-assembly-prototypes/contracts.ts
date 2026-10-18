import { AsyncSeriesHook, AsyncSeriesWaterfallHook } from 'tapable';

export type PieceName = string;
export type HookName = string;
export type Blueprint = {
  name: string;
  pieces: PieceName[];
  bindings: Record<string, string>;
  hookOrder: Record<HookName, PieceName[]>;
};

export interface Storage {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export type Message = { role: 'user' | 'assistant' | 'tool' | 'context'; text: string };
export type Call = { name: string; text: string };
export type ToolResult = { text: string; source: 'executed' | 'cache' | 'denied' };
export type Invocation = { kind: 'pending'; call: Call } | { kind: 'settled'; call: Call; result: ToolResult };
export type Request = { messages: Message[] };
export type Response = { kind: 'call'; call: Call } | { kind: 'answer'; text: string };
export type Report = { status: 'completed' | 'cancelled' | 'failed'; input: string; answer?: string };
export type Trace = { type: string; detail?: unknown };
export type Emit = (type: string, detail?: unknown) => void;

/** Per-run capabilities supplied to policy hooks; no history mutation rights. */
export type RunContext = {
  signal: AbortSignal;
  emit: Emit;
  ask(question: string): Promise<boolean>;
};

/** Tapable owns dispatch and ordering; plugins can expose additional typed hooks. */
export class AgentHooks {
  request = new AsyncSeriesWaterfallHook<[Request, RunContext]>(['request', 'run']);
  tool = new AsyncSeriesWaterfallHook<[Invocation, RunContext]>(['invocation', 'run']);
  end = new AsyncSeriesHook<[Report, RunContext]>(['report', 'run']);
}

export type Agent = {
  name: string;
  hooks: AgentHooks;
  model(request: Request, run: RunContext): Promise<Response>;
  execute(call: Call, run: RunContext): Promise<string>;
};

export type Piece = {
  install(hooks: AgentHooks, blueprint: Blueprint): void;
};

export type PieceDefinition = {
  requires: string[];
  hooks: HookName[];
  create(dependencies: Record<string, unknown>): Piece;
};
export type Catalog = Record<string, PieceDefinition>;

/** Assembly validates static choices before returning any executable agent. */
export function validateBlueprint(blueprint: Blueprint, serviceNames: string[], catalog: Catalog): void {
  if (blueprint.pieces.some((piece) => !Object.hasOwn(catalog, piece))) throw new Error('Unknown piece');
  if (new Set(blueprint.pieces).size !== blueprint.pieces.length) throw new Error('Duplicate piece');
  for (const [local, target] of Object.entries(blueprint.bindings)) {
    if (!serviceNames.includes(target)) throw new Error(`Unknown service binding: ${local} -> ${target}`);
    if (blueprint.pieces.includes(local)) throw new Error(`Binding shadows selected piece: ${local}`);
  }
  for (const name of blueprint.pieces) {
    for (const dependency of catalog[name].requires) {
      if (!blueprint.pieces.includes(dependency) && !Object.hasOwn(blueprint.bindings, dependency))
        throw new Error(`${name} requires ${dependency}: select the piece or bind a service`);
    }
  }
  const expected: Record<HookName, PieceName[]> = {};
  for (const piece of blueprint.pieces) {
    for (const hook of catalog[piece].hooks) (expected[hook] ??= []).push(piece);
  }
  for (const name of new Set([...Object.keys(expected), ...Object.keys(blueprint.hookOrder)])) {
    const order = blueprint.hookOrder[name];
    if (
      !order ||
      new Set(order).size !== order.length ||
      [...order].sort().join() !== (expected[name] ?? []).sort().join()
    )
      throw new Error(`${name}: order must list each selected handler exactly once`);
  }
}

/** Config order is converted to Tapable stages, independently of install order. */
export function tapOrder(blueprint: Blueprint, hook: HookName, name: PieceName) {
  return { name, stage: blueprint.hookOrder[hook].indexOf(name) };
}
