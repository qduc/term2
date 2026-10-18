import { AsyncSeriesWaterfallHook } from 'tapable';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  tapOrder,
  type AgentHooks,
  type Blueprint,
  type Catalog,
  type Piece,
  type Request,
  type Storage,
} from './contracts.js';

/** Shared filesystem storage, with independent keys for each agent. */
export class FileStorage implements Storage {
  constructor(readonly directory: string) {}

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.directory, encodeURIComponent(key)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, encodeURIComponent(key)), value, 'utf8');
  }
}

/** Memory consumes storage and owns an extension point used by the redactor. */
export class Memory implements Piece {
  beforeSave = new AsyncSeriesWaterfallHook<[string]>(['text']);
  constructor(readonly storage: Storage) {}

  install(hooks: AgentHooks, blueprint: Blueprint): void {
    hooks.request.tapPromise(
      tapOrder(blueprint, 'request.prepare', 'memory'),
      async (request, run): Promise<Request> => {
        run.emit('hook.memory');
        const memory = await this.storage.get(blueprint.name);
        return { messages: memory ? [{ role: 'context', text: memory }, ...request.messages] : request.messages };
      },
    );
    hooks.end.tapPromise('memory', async (report, run) => {
      if (report.status !== 'completed' || run.signal.aborted) return;
      const text = await this.beforeSave.promise(report.input);
      run.signal.throwIfAborted();
      await this.storage.put(blueprint.name, text);
      run.emit('memory.saved', text);
    });
  }
}

/** An independent piece extends a hook exposed by memory, not the core. */
export class Redact implements Piece {
  constructor(readonly memory: Memory) {}
  install(_hooks: AgentHooks, blueprint: Blueprint): void {
    this.memory.beforeSave.tap(tapOrder(blueprint, 'memory.beforeSave', 'redact'), (text) =>
      text.replace(/secret=[^\s]+/g, 'secret=[redacted]'),
    );
  }
}

export class Rewrite implements Piece {
  install(hooks: AgentHooks, blueprint: Blueprint): void {
    hooks.tool.tapPromise(tapOrder(blueprint, 'tool.execute', 'rewrite'), async (invocation, run) => {
      run.emit('hook.rewrite');
      return invocation.kind === 'settled'
        ? invocation
        : {
            kind: 'pending',
            call: { ...invocation.call, text: invocation.call.text.trim().toUpperCase() },
          };
    });
  }
}

export class Approval implements Piece {
  install(hooks: AgentHooks, blueprint: Blueprint): void {
    hooks.tool.tapPromise(tapOrder(blueprint, 'tool.execute', 'approval'), async (invocation, run) => {
      run.emit('hook.approval');
      if (invocation.kind === 'settled') return invocation;
      const allowed = await run.ask(`Allow ${invocation.call.name}(${invocation.call.text})?`);
      run.signal.throwIfAborted();
      return allowed
        ? invocation
        : {
            kind: 'settled',
            call: invocation.call,
            result: { text: 'Denied', source: 'denied' },
          };
    });
  }
}

export class Cache implements Piece {
  install(hooks: AgentHooks, blueprint: Blueprint): void {
    hooks.tool.tapPromise(tapOrder(blueprint, 'tool.execute', 'cache'), async (invocation, run) => {
      run.emit('hook.cache');
      // Deliberately seeded exact-key cache: order relative to rewrite is visible.
      if (invocation.kind === 'settled' || invocation.call.text !== 'HELLO') return invocation;
      return { kind: 'settled', call: invocation.call, result: { text: 'cached:HELLO', source: 'cache' } };
    });
  }
}

/** Local deterministic provider: one tool call, then an answer using its result. */
export async function scriptedModel(request: Request) {
  const result = request.messages.findLast((message) => message.role === 'tool');
  return result
    ? { kind: 'answer' as const, text: result.text }
    : { kind: 'call' as const, call: { name: 'echo', text: ' hello ' } };
}

/** Piece declarations belong to the feature catalog, not the loop or assembler. */
export const catalog: Catalog = {
  memory: {
    requires: ['storage'],
    hooks: ['request.prepare'],
    create: ({ storage }) => new Memory(storage as Storage),
  },
  redact: {
    requires: ['memory'],
    hooks: ['memory.beforeSave'],
    create: ({ memory }) => new Redact(memory as Memory),
  },
  rewrite: { requires: [], hooks: ['tool.execute'], create: () => new Rewrite() },
  approval: { requires: [], hooks: ['tool.execute'], create: () => new Approval() },
  cache: { requires: [], hooks: ['tool.execute'], create: () => new Cache() },
};
