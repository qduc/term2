import test from 'ava';
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

test('add returns a removal function', (t) => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const remove = registry.add(async () => null);
  t.is(typeof remove, 'function');
  remove();
  t.pass();
});

test('check returns null when no interceptors registered', async (t) => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const result = await registry.check('some_tool', {});
  t.is(result, null);
});

test('check returns null when all interceptors return null', async (t) => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => null);
  registry.add(async () => null);
  const result = await registry.check('some_tool', {});
  t.is(result, null);
});

test('check returns first non-null rejection', async (t) => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => null);
  registry.add(async () => 'second interceptor rejected');
  const result = await registry.check('some_tool', {});
  t.is(result, 'second interceptor rejected');
});

test('check short-circuits on first rejection', async (t) => {
  let secondCalled = false;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => 'first interceptor rejected');
  registry.add(async () => {
    secondCalled = true;
    return 'second interceptor rejected';
  });
  const result = await registry.check('some_tool', {});
  t.is(result, 'first interceptor rejected');
  t.false(secondCalled);
});

test('check catches thrown errors and returns error message', async (t) => {
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async () => {
    throw new Error('something went wrong');
  });
  const result = await registry.check('some_tool', {});
  t.truthy(result);
  t.true(result!.includes('something went wrong'));
});

test('check logs errors from interceptors', async (t) => {
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
  t.is(loggedMessage, 'Tool interceptor threw an error');
  t.is(loggedMeta?.name, 'some_tool');
  t.is(loggedMeta?.toolCallId, 'call-123');
  t.is(loggedMeta?.error, 'boom');
});

test('removed interceptor is no longer called', async (t) => {
  let callCount = 0;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  const interceptor = async () => {
    callCount++;
    return null;
  };
  const remove = registry.add(interceptor);
  remove();
  await registry.check('some_tool', {});
  t.is(callCount, 0);
});

test('check passes toolCallId to interceptors', async (t) => {
  let capturedToolCallId: string | undefined;
  const registry = new ToolInterceptorRegistry({ logger: createMockLogger() });
  registry.add(async (_name, _params, toolCallId) => {
    capturedToolCallId = toolCallId;
    return null;
  });
  await registry.check('some_tool', {}, 'tool-call-42');
  t.is(capturedToolCallId, 'tool-call-42');
});
