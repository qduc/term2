import { asClass, asFunction, asValue, aliasTo, createContainer, InjectionMode } from 'awilix';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import {
  AgentHooks,
  validateBlueprint,
  type Agent,
  type Blueprint,
  type Catalog,
  type Piece,
  type PieceName,
  type Storage,
} from './contracts.js';
import { catalog as defaultCatalog, type Memory, scriptedModel } from './pieces.js';

export type Assembly = {
  agent: Agent;
  memory?: Memory;
  storage?: Storage;
  close(): Promise<void>;
};

export type Host = {
  create(blueprint: Blueprint): Promise<Assembly>;
  ready?(): Promise<void>;
  close(): Promise<void>;
};

function executable(name: string, hooks: AgentHooks): Agent {
  return {
    name,
    hooks,
    model: scriptedModel,
    execute: async (call, run) => {
      run.emit('physical.execute', call.text);
      return `executed:${call.text}`;
    },
  };
}

/** A: Awilix resolves declared constructor dependencies lazily in each agent scope. */
export function createAwilixHost(storages: Record<string, Storage>, catalog: Catalog = defaultCatalog): Host {
  const root = createContainer({ injectionMode: InjectionMode.PROXY, strict: true });
  for (const [name, storage] of Object.entries(storages)) root.register(name, asValue(storage));
  const scopes: ReturnType<typeof root.createScope>[] = [];

  return {
    async create(blueprint) {
      validateBlueprint(blueprint, Object.keys(storages), catalog);
      const scope = root.createScope();
      scopes.push(scope);
      scope.register('hooks', asClass(AgentHooks).scoped());
      for (const [local, target] of Object.entries(blueprint.bindings)) scope.register(local, aliasTo(target));
      for (const name of blueprint.pieces) scope.register(name, asFunction(catalog[name].create).scoped());

      // Eager resolution makes missing dependencies a startup error.
      const hooks = scope.resolve<AgentHooks>('hooks');
      for (const name of blueprint.pieces) scope.resolve<Piece>(name).install(hooks, blueprint);

      return {
        agent: executable(blueprint.name, hooks),
        memory: scope.hasRegistration('memory') ? scope.resolve<Memory>('memory') : undefined,
        storage: blueprint.bindings.storage ? scope.resolve<Storage>('storage') : undefined,
        close: () => scope.dispose(),
      };
    },
    async close() {
      for (const scope of scopes) await scope.dispose();
      await root.dispose();
    },
  };
}

/** B: Fastify encapsulation gives agent scopes; plugin metadata validates dependencies. */
export function createFastifyHost(storages: Record<string, Storage>, catalog: Catalog = defaultCatalog): Host {
  const app = Fastify({ logger: false });
  const assemblies = new Map<string, Assembly>();
  let booted = false;

  return {
    async create(blueprint) {
      if (booted) throw new Error('Fastify assembly is frozen after boot; create a new host to add agents');
      validateBlueprint(blueprint, Object.keys(storages), catalog);

      app.register(async (scope) => {
        const hooks = new AgentHooks();
        scope.decorate('agentHooks', hooks);

        // Service selection is explicit; the instance belongs to the app host.
        for (const [local, target] of Object.entries(blueprint.bindings)) {
          scope.register(
            fp(
              async (services) => {
                services.decorate(local, storages[target]);
              },
              { name: local },
            ),
          );
        }

        // Fastify checks dependencies but does not sort plugins for us.
        // Unlike A, this prototype requires prerequisite-first piece order.
        for (const name of blueprint.pieces) {
          const dependencies = catalog[name].requires;
          scope.register(
            fp(
              async (services) => {
                const piece = catalog[name].create(
                  Object.fromEntries(dependencies.map((dependency) => [dependency, services.getDecorator(dependency)])),
                );
                services.decorate(name, piece);
                piece.install(hooks, blueprint);
              },
              { name, dependencies },
            ),
          );
        }

        scope.after(() => {
          assemblies.set(blueprint.name, {
            agent: executable(blueprint.name, hooks),
            memory: scope.hasDecorator('memory') ? scope.getDecorator<Memory>('memory') : undefined,
            storage: scope.hasDecorator('storage') ? scope.getDecorator<Storage>('storage') : undefined,
            // Fastify disposes the plugin tree together at host.close().
            close: async () => {},
          });
        });
      });

      // Boot is deliberately deferred so multiple agent scopes can be registered.
      return {
        get agent() {
          const assembly = assemblies.get(blueprint.name);
          if (!assembly) throw new Error('Call host.ready() before using a Fastify agent');
          return assembly.agent;
        },
        get memory() {
          return assemblies.get(blueprint.name)?.memory;
        },
        get storage() {
          return assemblies.get(blueprint.name)?.storage;
        },
        close: async () => {},
      };
    },
    async ready() {
      booted = true;
      await app.ready();
    },
    close: () => app.close(),
  };
}

export type Backend = 'awilix' | 'fastify';

/** Common host boundary; A resolves immediately, B boots its plugin tree once. */
export function createHost(backend: Backend, storages: Record<string, Storage>) {
  return backend === 'awilix' ? createAwilixHost(storages) : createFastifyHost(storages);
}

export async function ready(host: Host): Promise<void> {
  await host.ready?.();
}

/** Readable default blueprint; tool hook order is independent of piece installation. */
export function blueprint(name: string, pieces: PieceName[], toolOrder?: PieceName[]): Blueprint {
  return {
    name,
    pieces,
    bindings: pieces.includes('memory') ? { storage: 'disk' } : {},
    hookOrder: {
      'request.prepare': pieces.includes('memory') ? ['memory'] : [],
      'tool.execute': toolOrder ?? pieces.filter((piece) => ['rewrite', 'approval', 'cache'].includes(piece)),
      'memory.beforeSave': pieces.includes('redact') ? ['redact'] : [],
    },
  };
}
