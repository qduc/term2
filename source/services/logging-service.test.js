import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoggingService } from '../../dist/services/logging-service.js';

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

const findMainLogFile = (logDir) => {
  const files = fs.readdirSync(logDir);
  return files.find((f) => f.endsWith('.log') && f.startsWith('term2-') && !f.includes('openrouter'));
};

test.before(() => {
  cleanupLogs();
});

test.after.always(() => {
  cleanupLogs();
});

test.serial('LoggingService initializes without error', async (t) => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
  });
  t.truthy(logger);
});

test.serial('creates log directory if it does not exist', async (t) => {
  const logDir = getTestLogDir();
  new LoggingService({ logDir, disableLogging: false });

  // Give it a moment to create the directory
  await new Promise((resolve) => setTimeout(resolve, 100));

  t.true(fs.existsSync(logDir));
});

test.serial('respects DISABLE_LOGGING flag', async (t) => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: true,
  });

  logger.info('test message', { foo: 'bar' });

  // Give it a moment
  await new Promise((resolve) => setTimeout(resolve, 100));

  // No error should occur, and no files should be created
  t.pass();
});

test.serial('uses DISABLE_LOGGING env when disableLogging is omitted', async (t) => {
  const logDir = getTestLogDir();
  const originalDisableLogging = process.env.DISABLE_LOGGING;
  process.env.DISABLE_LOGGING = '1';

  try {
    new LoggingService({ logDir });

    // Give it a moment
    await new Promise((resolve) => setTimeout(resolve, 100));

    t.false(fs.existsSync(logDir));
  } finally {
    if (originalDisableLogging === undefined) {
      delete process.env.DISABLE_LOGGING;
    } else {
      process.env.DISABLE_LOGGING = originalDisableLogging;
    }
  }
});

test.serial('logs messages with correct format', async (t) => {
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

  t.true(logFiles.length > 0, 'log file should exist');

  if (logFiles.length === 0) {
    t.fail('No log files created');
    return;
  }

  // Read the log file and verify content is JSON
  const logFile = path.join(logDir, logFiles[0]);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());

  t.true(lines.length > 0, 'log file should have entries');

  // Verify JSON format
  const firstLog = JSON.parse(lines[0]);
  t.is(firstLog.message, 'test info message');
  t.is(firstLog.context, 'test');
});

test.serial('supports custom log levels including security', async (t) => {
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

  t.pass();
});

test.serial('suppresses console output when configured', async (t) => {
  const logDir = getTestLogDir();
  const originalConsoleError = console.error;
  const calls = [];

  console.error = (...args) => {
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

    t.is(calls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test.serial('tracks correlation IDs', async (t) => {
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
    t.fail('No log files created');
    return;
  }

  const logFile = path.join(logDir, logFiles[0]);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());

  const log = JSON.parse(lines[lines.length - 1] || lines[0]);
  t.is(log.correlationId, correlationId);

  logger.clearCorrelationId();
  logger.info('message without correlation', {});

  await new Promise((resolve) => setTimeout(resolve, 200));

  const content2 = fs.readFileSync(logFile, 'utf8');
  const lines2 = content2.split('\n').filter((l) => l.trim());

  const log2 = JSON.parse(lines2[lines2.length - 1]);
  t.is(log2.correlationId, undefined);
});

test.serial('gracefully degrades on write errors', async (t) => {
  const logDir = getTestLogDir();
  const logger = new LoggingService({
    logDir,
    disableLogging: false,
  });

  // This should not throw even if writes fail
  logger.info('test', {});
  logger.error('error', {});

  t.pass();
});

test.serial('emits canonical contract fields on logs', async (t) => {
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
  t.truthy(mainLogFile);
  if (!mainLogFile) {
    t.fail('No main log file created');
    return;
  }
  const logFile = path.join(logDir, mainLogFile);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);

  t.truthy(entry.timestamp);
  t.is(entry.eventType, 'stream.started');
  t.truthy(entry.traceId);
  t.is(entry.sessionId, 'session-contract');
  t.is(entry.provider, 'openai');
  t.is(entry.model, 'gpt-5');
  t.is(entry.phase, 'request_start');
});

test.serial('respects LOG_CATEGORIES filter while preserving errors', async (t) => {
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
    t.truthy(mainLogFile);
    if (!mainLogFile) {
      t.fail('No main log file created');
      return;
    }
    const logFile = path.join(logDir, mainLogFile);
    const content = fs.readFileSync(logFile, 'utf8');
    const entries = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    t.true(entries.some((entry) => entry.eventType === 'retry.upstream'));
    t.true(entries.some((entry) => entry.eventType === 'stream.failed'));
    t.false(entries.some((entry) => entry.eventType === 'tool_call.execution_started'));
  } finally {
    if (originalCategories === undefined) {
      delete process.env.LOG_CATEGORIES;
    } else {
      process.env.LOG_CATEGORIES = originalCategories;
    }
  }
});
