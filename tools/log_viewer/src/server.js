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

function safeBasename(name) {
  // prevent traversal and only allow filenames without path segments
  return path.basename(name || '');
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/files', async (req, res) => {
  try {
    const files = await fs.promises.readdir(LOG_DIR);
    const results = await Promise.all(files.map(async (f) => {
      try {
        const filePath = path.join(LOG_DIR, f);
        const st = await fs.promises.stat(filePath);
        return {
          name: f,
          size: st.size,
          mtime: st.mtime,
          isFile: st.isFile()
        };
      } catch (err) {
        return null;
      }
    }));
    res.json(results.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
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

function parseLine(line) {
  // try JSON parse, otherwise return raw
  try {
    const obj = JSON.parse(line);
    // ensure timestamp formatting for frontend
    if (obj.timestamp) obj._ts = dayjs(obj.timestamp).toISOString();
    return {raw: line, parsed: obj};
  } catch (e) {
    return {raw: line, parsed: null};
  }
}

app.get('/api/preview', async (req, res) => {
  const file = safeBasename(req.query.file || '');
  if (!file) return res.status(400).json({error: 'file query required'});
  const lines = Number(req.query.lines) || 200;
  try {
    const filePath = path.join(LOG_DIR, file);
    if (!filePath.startsWith(path.resolve(LOG_DIR))) return res.status(403).json({error:'forbidden'});
    const exists = await fs.promises.stat(filePath);
    if (!exists.isFile()) return res.status(404).json({error: 'not found'});
    const rawLines = await tailFile(filePath, MAX_READ_BYTES, lines);
    const parsed = rawLines.map(parseLine);
    res.json({file, lines: parsed.length, data: parsed});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// simple endpoint to get last-modified and size and an incremental token for polling
app.get('/api/meta', async (req, res) => {
  const file = safeBasename(req.query.file || '');
  if (!file) return res.status(400).json({error: 'file query required'});
  try {
    const filePath = path.join(LOG_DIR, file);
    const st = await fs.promises.stat(filePath);
    res.json({size: st.size, mtime: st.mtime});
  } catch (err) {
    res.status(404).json({error: String(err)});
  }
});

const port = process.env.PORT || 9100;
app.listen(port, () => {
  console.log(`Term2 log viewer listening on http://localhost:${port} -- logs at ${LOG_DIR}`);
});
