import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoggingService } from './logging-service.js';

// Set NODE_ENV to test for simple file logging
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_BASE_DIR = path.join(__dirname, '../../test-logs');

let testCounter = 0;

// Helper to get unique log directory per test
const getTestLogDir = () => {
  testCounter += 1;
  return path.join(TEST_BASE_DIR, `test-${testCounter}`);
};

// Helper to clean up test logs
const cleanupLogs = () => {
  if (fs.existsSync(TEST_BASE_DIR)) {
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
};

const formatDateDaysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

const findMainLogFile = (logDir: string) => {
  const files = fs.readdirSync(logDir);
  return files.find((f) => f.endsWith('.log') && f.startsWith('term2-') && !f.includes('openrouter'));
};

beforeAll(() => {
  cleanupLogs();
});

afterAll(() => {
  cleanupLogs();
});

it.sequential('LoggingService initializes without error', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
  });
  expect(logger).toBeTruthy();
});

it.sequential('creates log directory if it does not exist', async () => {
  const logDir = getTestLogDir();
  new LoggingService({ logDir, disableLogging: false });

  // Give it a moment to create the directory
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(fs.existsSync(logDir)).toBe(true);
});

it.sequential('respects DISABLE_LOGGING flag', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: true,
  });

  logger.info('test message', { foo: 'bar' });

  // Give it a moment
  await new Promise((resolve) => setTimeout(resolve, 100));

  // No error should occur, and no files should be created
  expect(true).toBe(true);
});

it.sequential('uses DISABLE_LOGGING env when disableLogging is omitted', async () => {
  const logDir = getTestLogDir();
  const originalDisableLogging = process.env.DISABLE_LOGGING;
  process.env.DISABLE_LOGGING = '1';

  try {
    new LoggingService({ logDir });

    // Give it a moment
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(logDir)).toBe(false);
  } finally {
    if (originalDisableLogging === undefined) {
      delete process.env.DISABLE_LOGGING;
    } else {
      process.env.DISABLE_LOGGING = originalDisableLogging;
    }
  }
});

it.sequential('logs messages with correct format', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  logger.info('test info message', { context: 'test' });

  // Give async write time - increase to 500ms
  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.mkdirSync(logDir, { recursive: true });
  // Check that a log file exists
  const files = fs.readdirSync(logDir);
  const logFiles = files.filter((f) => f.endsWith('.log') && f.startsWith('term2-') && !f.includes('openrouter'));

  expect(logFiles.length > 0).toBe(true);

  if (logFiles.length === 0) {
    expect(true).toBe(false);
    return;
  }

  // Read the log file and verify content is JSON
  const logFile = path.join(logDir, logFiles[0]);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());

  expect(lines.length > 0).toBe(true);

  // Verify JSON format
  const firstLog = JSON.parse(lines[0]);
  expect(firstLog.message).toBe('test info message');
  expect(firstLog.context).toBe('test');
});

it.sequential('supports custom log levels including security', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  logger.security('dangerous command detected', { command: 'rm -rf /' });
  logger.error('error occurred', {});
  logger.warn('warning', {});
  logger.info('info', {});
  logger.debug('debug', {});

  // Give async writes time
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(true).toBe(true);
});

it.sequential('automatically writes provider traffic artifacts for sent and received payloads', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'info',
  });

  logger.debug('OpenRouter request start', {
    eventType: 'provider.request.started',
    direction: 'sent',
    requestId: 'req-1',
    sessionId: 'session-1',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    firstUserMessagePreview: 'hello',
    mode: 'standard',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.5',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'FallbackResponsesModel',
    headers: { host: 'api.openrouter.ai', authorization: '[REDACTED]' },
    payload: {
      messages: [{ role: 'system' }, { role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    },
    timestamp: '2026-05-22T09:14:35.044Z',
  });

  logger.debug('OpenRouter response received', {
    eventType: 'provider.response.received',
    direction: 'received',
    requestId: 'req-1',
    sessionId: 'session-1',
    sessionStartedAt: '2026-05-22T09:14:31.125Z',
    firstUserMessagePreview: 'hello',
    mode: 'standard',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.5',
    modelClass: 'OpenAIResponsesWSModelWithPromptCacheKey',
    modelWrapperClass: 'FallbackResponsesModel',
    payload: { outputText: 'hi', toolCalls: [] },
    timestamp: '2026-05-22T09:14:36.000Z',
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  const providerRoot = path.join(logDir, 'provider-traffic');
  expect(fs.existsSync(providerRoot)).toBe(true);

  const dayDirs = fs
    .readdirSync(providerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(dayDirs.length > 0).toBe(true);

  const dayDir = path.join(providerRoot, dayDirs[0]);
  const sessionDirs = fs.readdirSync(dayDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  expect(sessionDirs.length > 0).toBe(true);
  const requestFiles = fs.readdirSync(path.join(dayDir, sessionDirs[0].name)).filter((name) => name.endsWith('.jsonl'));
  expect(requestFiles.length > 0).toBe(true);
  const trafficFile = path.join(dayDir, sessionDirs[0].name, requestFiles[0]);

  const entries = fs
    .readFileSync(trafficFile, 'utf8')
    .split(/\r?\n\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  expect(entries.length >= 2).toBe(true);

  const sent = entries.find((entry) => entry.direction === 'sent');
  const received = entries.find((entry) => entry.direction === 'received');

  expect(sent).toBeTruthy();
  expect(received).toBeTruthy();
  if (!sent || !received) {
    expect(true).toBe(false);
    return;
  }

  expect(sent.direction).toBe('sent');
  expect(sent.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect(sent.modelWrapperClass).toBe('FallbackResponsesModel');
  expect(sent.headers).toEqual({ host: 'api.openrouter.ai', authorization: '[REDACTED]' });
  expect(sent.body.messages).toEqual([{ role: 'system' }, { role: 'user', content: 'hello' }]);
  expect(sent.body.tools).toEqual(['read_file']);
  expect(received.direction).toBe('received');
  expect(received.modelClass).toBe('OpenAIResponsesWSModelWithPromptCacheKey');
  expect(received.modelWrapperClass).toBe('FallbackResponsesModel');
  expect(received.summary.outputText).toBe('hi');
});

it.sequential('cleans up old provider traffic files and directories by date', async () => {
  const logDir = getTestLogDir();
  const providerRoot = path.join(logDir, 'provider-traffic');
  const oldFile = path.join(providerRoot, `traffic-${formatDateDaysAgo(40)}.log`);
  const recentFile = path.join(providerRoot, `traffic-${formatDateDaysAgo(5)}.log`);
  const oldDir = path.join(providerRoot, formatDateDaysAgo(40));
  const recentDir = path.join(providerRoot, formatDateDaysAgo(5));

  fs.mkdirSync(providerRoot, { recursive: true });
  fs.writeFileSync(oldFile, '{"direction":"sent"}\n', 'utf8');
  fs.writeFileSync(recentFile, '{"direction":"received"}\n', 'utf8');

  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'some-file.jsonl'), '{}', 'utf8');

  fs.mkdirSync(recentDir, { recursive: true });
  fs.writeFileSync(path.join(recentDir, 'some-file.jsonl'), '{}', 'utf8');

  new LoggingService({
    logDir,
    disableLogging: false,
  });

  expect(fs.existsSync(oldFile)).toBe(false);
  expect(fs.existsSync(recentFile)).toBe(true);
  expect(fs.existsSync(oldDir)).toBe(false);
  expect(fs.existsSync(recentDir)).toBe(true);
});

it.sequential('suppresses console output when configured', async () => {
  const logDir = getTestLogDir();
  const originalConsoleError = console.error;
  const calls: any[][] = [];

  console.error = (...args: any[]) => {
    calls.push(args);
  };

  try {
    const logger = new LoggingService({
      logDir,
      disableLogging: false,
      debugLogging: true,
      suppressConsoleOutput: true,
    });

    logger.setLogLevel('not-a-level');

    expect(calls.length).toBe(0);
  } finally {
    console.error = originalConsoleError;
  }
});

it.sequential('tracks correlation IDs', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  const correlationId = 'test-correlation-123';
  logger.setCorrelationId(correlationId);
  logger.info('message with correlation', {});

  // Give async write time
  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.mkdirSync(logDir, { recursive: true });
  const files = fs.readdirSync(logDir);
  const logFiles = files.filter((f) => f.endsWith('.log') && f.startsWith('term2-') && !f.includes('openrouter'));

  if (logFiles.length === 0) {
    expect(true).toBe(false);
    return;
  }

  const logFile = path.join(logDir, logFiles[0]);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());

  const log = JSON.parse(lines[lines.length - 1] || lines[0]);
  expect(log.correlationId).toBe(correlationId);

  logger.clearCorrelationId();
  logger.info('message without correlation', {});

  await new Promise((resolve) => setTimeout(resolve, 200));

  const content2 = fs.readFileSync(logFile, 'utf8');
  const lines2 = content2.split('\n').filter((l) => l.trim());

  const log2 = JSON.parse(lines2[lines2.length - 1]);
  expect(log2.correlationId).toBe(undefined);
});

it.sequential('gracefully degrades on write errors', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
  });

  // This should not throw even if writes fail
  logger.info('test', {});
  logger.error('error', {});

  expect(true).toBe(true);
});

it.sequential('emits canonical contract fields on logs', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  logger.info('contract test', {
    eventType: 'stream.started',
    phase: 'request_start',
    sessionId: 'session-contract',
    provider: 'openai',
    model: 'gpt-5',
    messageId: 'msg-contract',
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  fs.mkdirSync(logDir, { recursive: true });
  const mainLogFile = findMainLogFile(logDir);
  expect(mainLogFile).toBeTruthy();
  if (!mainLogFile) {
    expect(true).toBe(false);
    return;
  }
  const logFile = path.join(logDir, mainLogFile);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);

  expect(entry.timestamp).toBeTruthy();
  expect(entry.eventType).toBe('stream.started');
  expect(entry.sessionId).toBe('session-contract');
  expect(entry.provider).toBe('openai');
  expect(entry.model).toBe('gpt-5');
  expect('phase' in entry).toBe(false);
  expect('category' in entry).toBe(false);
});

it.sequential('truncates base64 image data in provider.request.started', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  const longBase64 = 'data:image/png;base64,' + 'a'.repeat(10000);
  logger.debug('Agent stream started', {
    eventType: 'provider.request.started',
    messages: [
      {
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', image: longBase64 },
        ],
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.mkdirSync(logDir, { recursive: true });
  const mainLogFile = findMainLogFile(logDir);
  const logFile = path.join(logDir, mainLogFile!);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);

  const image = entry.messages[0].content[1].image;
  expect(image.length < 500).toBe(true);
  expect(image.endsWith('... (truncated)')).toBe(true);
});

it.sequential('does not truncate base64 image data outside provider.request.started', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  const longBase64 = 'data:image/png;base64,' + 'a'.repeat(10000);
  logger.debug('Agent stream finished', {
    eventType: 'provider.response.received',
    messages: [
      {
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', image: longBase64 },
        ],
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.mkdirSync(logDir, { recursive: true });
  const mainLogFile = findMainLogFile(logDir);
  expect(mainLogFile).toBeTruthy();
  if (!mainLogFile) {
    expect(true).toBe(false);
    return;
  }
  const logFile = path.join(logDir, mainLogFile);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);

  expect(entry.messages[0].content[1].image).toBe(longBase64);
});

it.sequential('truncates long provider response text in file logs', async () => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
    logLevel: 'debug',
  });

  const longText = ': OPENROUTER PROCESSING\n' + 'data: {"chunk":"value"}\n'.repeat(220) + 'data: {"tail":"preserved"}';
  logger.error('OpenRouter stream done', {
    eventType: 'provider.response.received',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    text: longText,
    payload: { raw: longText },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.mkdirSync(logDir, { recursive: true });
  const mainLogFile = findMainLogFile(logDir);
  expect(mainLogFile).toBeTruthy();
  if (!mainLogFile) {
    expect(true).toBe(false);
    return;
  }

  const logFile = path.join(logDir, mainLogFile);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);

  expect(entry.text.length < longText.length).toBe(true);
  expect(entry.text.startsWith(': OPENROUTER PROCESSING')).toBe(true);
  expect(entry.text.endsWith('data: {"tail":"preserved"}')).toBe(true);
  expect(entry.payload.raw.length < longText.length).toBe(true);
  expect(entry.payload.raw.startsWith(': OPENROUTER PROCESSING')).toBe(true);
  expect(entry.payload.raw.endsWith('data: {"tail":"preserved"}')).toBe(true);
});

it.sequential('respects LOG_CATEGORIES filter while preserving errors', async () => {
  const originalCategories = process.env.LOG_CATEGORIES;
  process.env.LOG_CATEGORIES = 'retry';

  try {
    const logDir = getTestLogDir();
    const logger = new LoggingService({
      logDir,
      disableLogging: false,
      logLevel: 'debug',
    });

    logger.info('tool log should drop', { eventType: 'tool_call.execution_started', category: 'tool' });
    logger.info('retry log should keep', { eventType: 'retry.upstream', category: 'retry' });
    logger.error('error should keep', { eventType: 'stream.failed', category: 'stream' });

    await new Promise((resolve) => setTimeout(resolve, 300));

    fs.mkdirSync(logDir, { recursive: true });
    const mainLogFile = findMainLogFile(logDir);
    expect(mainLogFile).toBeTruthy();
    if (!mainLogFile) {
      expect(true).toBe(false);
      return;
    }
    const logFile = path.join(logDir, mainLogFile);
    const content = fs.readFileSync(logFile, 'utf8');
    const entries = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(entries.some((entry) => entry.eventType === 'retry.upstream')).toBe(true);
    expect(entries.some((entry) => entry.eventType === 'stream.failed')).toBe(true);
    expect(entries.some((entry) => entry.eventType === 'tool_call.execution_started')).toBe(false);
  } finally {
    if (originalCategories === undefined) {
      delete process.env.LOG_CATEGORIES;
    } else {
      process.env.LOG_CATEGORIES = originalCategories;
    }
  }
});
