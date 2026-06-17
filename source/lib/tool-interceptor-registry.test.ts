import { it, expect } from 'vitest';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import type { ILoggingService } from '../services/service-interfaces.js';

const createMockLogger = (): ILoggingService => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
});

it('add returns a removal function', () => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const remove = registry.add(async () => null);
  expect(typeof remove).toBe('function');
  remove();
  expect(true).toBe(true);
});

it('check returns null when no interceptors registered', async () => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const result = await registry.check('some_tool', {});
  expect(result).toBe(null);
});

it('check returns null when all interceptors return null', async () => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => null);
  registry.add(async () => null);
  const result = await registry.check('some_tool', {});
  expect(result).toBe(null);
});

it('check returns first non-null rejection', async () => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => null);
  registry.add(async () => 'second interceptor rejected');
  const result = await registry.check('some_tool', {});
  expect(result).toBe('second interceptor rejected');
});

it('check short-circuits on first rejection', async () => {
  let secondCalled = false;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => 'first interceptor rejected');
  registry.add(async () => {
    secondCalled = true;
    return 'second interceptor rejected';
  });
  const result = await registry.check('some_tool', {});
  expect(result).toBe('first interceptor rejected');
  expect(secondCalled).toBe(false);
});

it('check catches thrown errors and returns error message', async () => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => {
    throw new Error('something went wrong');
  });
  const result = await registry.check('some_tool', {});
  expect(result).toBeTruthy();
  expect(result!.includes('something went wrong')).toBe(true);
});

it('check logs errors from interceptors', async () => {
  let loggedMessage = '';
  let loggedMeta: any = null;
  const logger: ILoggingService = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
    error: (message: string, meta?: any) => {
      loggedMessage = message;
      loggedMeta = meta;
    },
  };
  const registry = new ToolInterceptorRegistry({ logger });
  registry.add(async () => {
    throw new Error('boom');
  });
  await registry.check('some_tool', { foo: 'bar' }, 'call-123');
  expect(loggedMessage).toBe('Tool interceptor threw an error');
  expect(loggedMeta?.name).toBe('some_tool');
  expect(loggedMeta?.toolCallId).toBe('call-123');
  expect(loggedMeta?.error).toBe('boom');
});

it('removed interceptor is no longer called', async () => {
  let callCount = 0;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const interceptor = async () => {
    callCount++;
    return null;
  };
  const remove = registry.add(interceptor);
  remove();
  await registry.check('some_tool', {});
  expect(callCount).toBe(0);
});

it('check passes toolCallId to interceptors', async () => {
  let capturedToolCallId: string | undefined;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async (_name, _params, toolCallId) => {
    capturedToolCallId = toolCallId;
    return null;
  });
  await registry.check('some_tool', {}, 'tool-call-42');
  expect(capturedToolCallId).toBe('tool-call-42');
});
