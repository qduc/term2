import { describe, expect, it, vi } from 'vitest';

import type { StatusChangeHookEvent, Term2HookRegistration } from './hook-contracts.js';
import type { DiscoveredHookFile } from './hook-discovery.js';
import type { HookModuleLoader } from './hook-module-loader.js';
import { HookRegistry } from './hook-registry.js';
import { HookService } from './hook-service.js';

const statusEvent = (eventId: string): StatusChangeHookEvent => ({
  type: 'status.change',
  schemaVersion: 1,
  eventId,
  sessionId: 'session-1',
  timestamp: 1,
  scope: 'root',
  previous: 'idle',
  current: 'working',
  reason: 'turn_started',
});

function fakeDiscovery(files: readonly DiscoveredHookFile[]) {
  return { discover: vi.fn(async () => ({ files, diagnostics: [] })) };
}

describe('HookService', () => {
  it('loads discovered files once in order and exposes emit/shutdown as a narrow port', async () => {
    const files: DiscoveredHookFile[] = [
      { path: '/hooks/user-a.ts', root: '/hooks', scope: 'user' },
      { path: '/project/.term2/hooks/project.ts', root: '/project/.term2/hooks', scope: 'project' },
    ];
    const order: string[] = [];
    const discovery = fakeDiscovery(files);
    const loader: HookModuleLoader = {
      load: vi.fn(
        async (path: string): Promise<Term2HookRegistration> =>
          (hooks) => {
            hooks.on('status.change', () => {
              order.push(path);
            });
          },
      ),
    };
    const service = new HookService({ discovery, moduleLoader: loader });

    await expect(service.start()).resolves.toMatchObject({
      loadedFiles: files.map((file) => file.path),
      skippedFiles: [],
    });
    await service.start();
    expect(discovery.discover).toHaveBeenCalledTimes(1);
    expect(loader.load).toHaveBeenCalledTimes(2);

    await service.emit(statusEvent('service-event-1'));
    expect(order).toEqual(files.map((file) => file.path));

    await service.shutdown();
    await service.emit(statusEvent('service-event-2'));
    expect(order).toEqual(files.map((file) => file.path));
  });

  it('isolates module load and registration failures while retaining valid modules', async () => {
    const files: DiscoveredHookFile[] = [
      { path: '/hooks/broken-load.ts', root: '/hooks', scope: 'user' },
      { path: '/hooks/broken-register.ts', root: '/hooks', scope: 'user' },
      { path: '/hooks/valid.ts', root: '/hooks', scope: 'user' },
    ];
    const diagnostics: string[] = [];
    const callback = vi.fn();
    const discovery = fakeDiscovery(files);
    const loader: HookModuleLoader = {
      load: vi.fn(async (path: string): Promise<Term2HookRegistration> => {
        if (path.endsWith('broken-load.ts')) throw new Error('syntax error');
        if (path.endsWith('broken-register.ts')) {
          return (hooks) => {
            hooks.on('status.change', callback);
            throw new Error('registration error');
          };
        }
        return (hooks) => {
          hooks.on('status.change', callback);
        };
      }),
    };
    const service = new HookService({
      discovery,
      moduleLoader: loader,
      logger: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    const result = await service.start();
    await service.emit(statusEvent('service-event-3'));

    expect(result.loadedFiles).toEqual(['/hooks/valid.ts']);
    expect(result.skippedFiles).toEqual(['/hooks/broken-load.ts', '/hooks/broken-register.ts']);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(['module_load_failed', 'registration_rejected']);
  });

  it('keeps diagnostics non-fatal when discovery itself fails', async () => {
    const logger = vi.fn();
    const service = new HookService({
      discovery: {
        discover: vi.fn(async () => {
          throw new Error('discovery unavailable');
        }),
      },
      logger,
    });

    const result = await service.start();

    expect(result.loadedFiles).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'discovery_failed' })]);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('can use an injected registry and does not emit after shutdown', async () => {
    const callback = vi.fn();
    const registry = new HookRegistry();
    await registry.register((hooks) => {
      hooks.on('status.change', callback);
    });
    const service = new HookService({
      discovery: fakeDiscovery([]),
      registry,
    });

    await service.start();
    await service.emit(statusEvent('service-event-4'));
    await service.shutdown();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(service.started).toBe(true);
  });
});
