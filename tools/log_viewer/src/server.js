const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const dayjs = require('dayjs');
const envPaths = require('env-paths').default;

const app = express();
app.use(cors());
app.use(express.json());

const LOG_DIR = process.env.LOG_DIR || path.join(envPaths('term2').log, 'logs');
const MAX_READ_BYTES = 1024 * 1024; // 1MB

function normalizeRelativePath(name) {
  const normalized = path.posix.normalize(String(name || '').replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return '';
  }
  return normalized;
}

function resolveFilePath(logDir, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  if (!safeRelative) {
    throw new Error('forbidden');
  }

  const resolvedLogDir = path.resolve(logDir);
  const resolvedFilePath = path.resolve(path.join(resolvedLogDir, safeRelative));
  if (!(resolvedFilePath === resolvedLogDir || resolvedFilePath.startsWith(resolvedLogDir + path.sep))) {
    throw new Error('forbidden');
  }
  return resolvedFilePath;
}

async function listLogFilesRecursive(logDir, baseDir = logDir, rel = '') {
  const dirPath = path.join(baseDir, rel);
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    const childPath = path.join(baseDir, childRel);
    try {
      const st = await fs.promises.stat(childPath);
      if (st.isDirectory()) {
        const nested = await listLogFilesRecursive(logDir, baseDir, childRel);
        results.push(...nested);
      } else if (st.isFile()) {
        results.push({
          name: childRel.replaceAll('\\', '/'),
          size: st.size,
          mtime: st.mtime,
          isFile: true,
        });
      }
    } catch (_) {
      // Ignore files that disappear between readdir/stat
    }
  }

  return results;
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/files', async (req, res) => {
  try {
    const files = await listLogFilesRecursive(LOG_DIR);
    files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime() || a.name.localeCompare(b.name));
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// read last N lines roughly by reading last bytes and splitting
async function tailFile(filePath, maxBytes = MAX_READ_BYTES, lines = 200) {
  const st = await fs.promises.stat(filePath);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const fh = await fs.promises.open(filePath, 'r');
  const buff = Buffer.alloc(Math.min(maxBytes, size));
  try {
    await fh.read(buff, 0, buff.length, start);
  } finally {
    await fh.close();
  }
  const text = buff.toString('utf8');
  const parts = text.split(/\r?\n/).filter(Boolean);
  // return last N
  return parts.slice(-lines);
}

async function readFromOffset(filePath, offset) {
  const st = await fs.promises.stat(filePath);
  const size = st.size;
  const safeOffset = Math.max(0, Number(offset) || 0);
  if (safeOffset >= size) {
    return {
      data: [],
      nextOffset: size,
      reset: safeOffset > size,
      size,
    };
  }

  const fh = await fs.promises.open(filePath, 'r');
  const length = size - safeOffset;
  const buff = Buffer.alloc(length);
  try {
    await fh.read(buff, 0, length, safeOffset);
  } finally {
    await fh.close();
  }

  const text = buff.toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return {
    data: lines.map(parseLine),
    nextOffset: size,
    reset: false,
    size,
  };
}

function parseLine(line) {
  // try JSON parse, otherwise return raw
  try {
    const obj = JSON.parse(line);
    // ensure timestamp formatting for frontend
    if (obj.timestamp) obj._ts = dayjs(obj.timestamp).toISOString();
    return { raw: line, parsed: obj };
  } catch (e) {
    return { raw: line, parsed: null };
  }
}

async function parsePreviewFile(filePath, lines) {
  if (filePath.endsWith('.json') && !filePath.endsWith('.ndjson')) {
    const text = await fs.promises.readFile(filePath, 'utf8');
    const single = parseLine(text.trim());
    return [single];
  }

  const rawLines = await tailFile(filePath, MAX_READ_BYTES, lines);
  return rawLines.reverse().map(parseLine);
}

app.get('/api/preview', async (req, res) => {
  const file = normalizeRelativePath(req.query.file || '');
  if (!file) return res.status(400).json({ error: 'file query required' });
  const lines = Number(req.query.lines) || 200;
  try {
    const filePath = resolveFilePath(LOG_DIR, file);
    const exists = await fs.promises.stat(filePath);
    if (!exists.isFile()) return res.status(404).json({ error: 'not found' });
    const parsed = await parsePreviewFile(filePath, lines);
    const st = await fs.promises.stat(filePath);
    res.json({ file, lines: parsed.length, data: parsed, offset: st.size });
  } catch (err) {
    if (String(err?.message || '').includes('forbidden')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/append', async (req, res) => {
  const file = normalizeRelativePath(req.query.file || '');
  if (!file) return res.status(400).json({ error: 'file query required' });
  const offset = Number(req.query.offset || 0);

  try {
    const resolvedFilePath = resolveFilePath(LOG_DIR, file);

    const st = await fs.promises.stat(resolvedFilePath);
    if (!st.isFile()) return res.status(404).json({ error: 'not found' });

    const result = await readFromOffset(resolvedFilePath, offset);
    res.json({
      file,
      offset: Number(offset) || 0,
      nextOffset: result.nextOffset,
      reset: result.reset,
      size: result.size,
      data: result.data,
    });
  } catch (err) {
    if (String(err?.message || '').includes('forbidden')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// simple endpoint to get last-modified and size and an incremental token for polling
app.get('/api/meta', async (req, res) => {
  const file = normalizeRelativePath(req.query.file || '');
  if (!file) return res.status(400).json({ error: 'file query required' });
  try {
    const filePath = resolveFilePath(LOG_DIR, file);
    const st = await fs.promises.stat(filePath);
    res.json({ size: st.size, mtime: st.mtime });
  } catch (err) {
    if (String(err?.message || '').includes('forbidden')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.status(404).json({ error: String(err) });
  }
});

// Server-Sent Events endpoint to watch a file for changes and notify clients
app.get('/api/watch', async (req, res) => {
  const file = normalizeRelativePath(req.query.file || '');
  if (!file) return res.status(400).json({ error: 'file query required' });
  try {
    const resolvedFilePath = resolveFilePath(LOG_DIR, file);

    const st = await fs.promises.stat(resolvedFilePath);
    if (!st.isFile()) return res.status(404).json({ error: 'not found' });

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (_) {
        // ignore write errors; connection might be closed
      }
    };

    // Initial meta
    send({ type: 'init', size: st.size, mtime: st.mtime });

    // Keep-alive ping every 20s
    const ping = setInterval(() => send({ type: 'ping', t: Date.now() }), 20000);

    const watcher = fs.watch(resolvedFilePath, { persistent: true }, async (_eventType) => {
      try {
        const mst = await fs.promises.stat(resolvedFilePath);
        send({ type: 'change', size: mst.size, mtime: mst.mtime });
      } catch (e) {
        // If file is removed or inaccessible
        send({ type: 'error', error: String(e) });
      }
    });

    // Cleanup on close
    const cleanup = () => {
      clearInterval(ping);
      try {
        watcher.close();
      } catch (_) {}
      try {
        res.end();
      } catch (_) {}
    };

    req.on('close', cleanup);
  } catch (err) {
    console.error(err);
    // If we already started SSE, try to send an error frame; else regular JSON
    if (!res.headersSent) {
      return res.status(500).json({ error: String(err) });
    }
    try {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          error: String(err),
        })}\n\n`,
      );
      res.end();
    } catch (_) {}
  }
});

const port = process.env.PORT || 9100;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Term2 log viewer listening on http://localhost:${port} -- logs at ${LOG_DIR}`);
  });
}

module.exports = {
  app,
  LOG_DIR,
  parseLine,
  normalizeRelativePath,
  resolveFilePath,
  listLogFilesRecursive,
  parsePreviewFile,
};
