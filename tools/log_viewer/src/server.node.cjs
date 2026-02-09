const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeRelativePath, resolveFilePath, listLogFilesRecursive, parsePreviewFile } = require('./server');

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-log-viewer-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-log-viewer-'));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeRelativePath keeps safe nested path and rejects traversal', () => {
  assert.equal(normalizeRelativePath('term2-2026-02-09.log'), 'term2-2026-02-09.log');
  assert.equal(
    normalizeRelativePath('provider-traffic/2026-02-09/trace-1/001-sent.json'),
    'provider-traffic/2026-02-09/trace-1/001-sent.json',
  );
  assert.equal(normalizeRelativePath('../term2-2026-02-09.log'), '');
  assert.equal(normalizeRelativePath('/etc/passwd'), '');
});

test('resolveFilePath rejects paths outside log dir', () => {
  withTempDir((logDir) => {
    const safePath = resolveFilePath(logDir, 'term2.log');
    assert.equal(safePath, path.join(logDir, 'term2.log'));

    assert.throws(() => resolveFilePath(logDir, '../escape.log'));
  });
});

test('listLogFilesRecursive returns files in nested provider-traffic directories', async () => {
  await withTempDirAsync(async (logDir) => {
    const topLog = path.join(logDir, 'term2-2026-02-09.log');
    const nested = path.join(logDir, 'provider-traffic', '2026-02-09', 'trace-1');
    const nestedFile = path.join(nested, '001-sent.json');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(topLog, '{"ok":true}\n', 'utf8');
    fs.writeFileSync(nestedFile, '{\n  "direction": "sent"\n}\n', 'utf8');

    const files = await listLogFilesRecursive(logDir);
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ['provider-traffic/2026-02-09/trace-1/001-sent.json', 'term2-2026-02-09.log']);
  });
});

test('parsePreviewFile parses pretty JSON provider traffic artifact as a single record', async () => {
  await withTempDirAsync(async (logDir) => {
    const trafficPath = path.join(logDir, 'provider-traffic', '2026-02-09', 'trace-1', '001-sent.json');
    fs.mkdirSync(path.dirname(trafficPath), { recursive: true });
    fs.writeFileSync(
      trafficPath,
      JSON.stringify(
        {
          traceId: 'trace-1',
          timestamp: '2026-02-09 11:00:00',
          direction: 'sent',
          sourceMessage: 'OpenRouter stream start',
        },
        null,
        2,
      ),
      'utf8',
    );

    const rows = await parsePreviewFile(trafficPath, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].parsed.traceId, 'trace-1');
    assert.equal(rows[0].parsed.direction, 'sent');
  });
});
