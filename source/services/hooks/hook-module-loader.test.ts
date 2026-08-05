import { describe, expect, it, vi } from 'vitest';

import { HookModuleLoadError, JitiHookModuleLoader, NativeHookModuleLoader } from './hook-module-loader.js';

describe('hook module loaders', () => {
  it('validates the default export of a native-loaded module', async () => {
    const registration = vi.fn();
    const loader = new NativeHookModuleLoader(async () => ({ default: registration }));

    await expect(loader.load('/hooks/example.js')).resolves.toBe(registration);
  });

  it('accepts a callable module value from an injected loader', async () => {
    const registration = vi.fn();
    const loader = new NativeHookModuleLoader(async () => registration);

    await expect(loader.load('/hooks/example.mjs')).resolves.toBe(registration);
  });

  it('rejects modules without a default registration function', async () => {
    const loader = new JitiHookModuleLoader(() => ({ named: () => undefined }));

    await expect(loader.load('/hooks/missing-default.ts')).rejects.toMatchObject({
      name: 'HookModuleLoadError',
      path: '/hooks/missing-default.ts',
    });
  });

  it('wraps evaluation errors with the source path', async () => {
    const cause = new SyntaxError('unexpected token');
    const loader = new JitiHookModuleLoader(() => {
      throw cause;
    });

    await expect(loader.load('/hooks/broken.ts')).rejects.toMatchObject({
      name: 'HookModuleLoadError',
      path: '/hooks/broken.ts',
      cause,
    });
  });

  it('supports async injected jiti evaluation', async () => {
    const registration = vi.fn();
    const loader = new JitiHookModuleLoader(async () => await Promise.resolve({ default: registration }));

    await expect(loader.load('/hooks/async.ts')).resolves.toBe(registration);
  });

  it('rejects a non-callable jiti loader at construction', () => {
    expect(() => new JitiHookModuleLoader(null as never)).toThrow(TypeError);
  });

  it('exposes the original path on a validation error', async () => {
    const loader = new NativeHookModuleLoader(async () => ({ default: 'not a function' }));

    await expect(loader.load('/hooks/invalid.js')).rejects.toBeInstanceOf(HookModuleLoadError);
    await expect(loader.load('/hooks/invalid.js')).rejects.toMatchObject({ path: '/hooks/invalid.js' });
  });
});
