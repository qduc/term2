const fileListEl = document.getElementById('files');
const logsTable = document.getElementById('logsTable');
const logsBody = document.getElementById('logsBody');
const info = document.getElementById('info');
const refreshBtn = document.getElementById('refresh');
const levelFilter = document.getElementById('levelFilter');
const searchInput = document.getElementById('search');
const linesInput = document.getElementById('lines');

let selectedFile = null;
let fileWatcher = null; // SSE watcher
let refreshTimer = null; // debounce timer for auto-refresh

function truncateContentDeep(value, maxDepth = 3, maxLen = 200) {
  const seen = new WeakSet();

  const truncateStr = (s, limit = maxLen) =>
    (typeof s === 'string' && s.length > limit) ? (s.slice(0, limit) + '…') : s;

  const sanitizeToolsArray = (toolsVal) => {
    if (!Array.isArray(toolsVal)) return toolsVal;

    const sanitizeNameDesc = (obj) => {
      const name = typeof obj.name === 'string' ? obj.name : undefined;
      const description = truncateStr(typeof obj.description === 'string' ? obj.description : undefined, maxLen);

      // Remove all fields except name/description
      for (const key in obj) {
        if (key !== 'name' && key !== 'description') {
          delete obj[key];
        }
      }
      obj.name = name;
      obj.description = description;

      // Keep output tidy (avoid emitting undefined fields)
      if (obj.name === undefined) delete obj.name;
      if (obj.description === undefined) delete obj.description;
    };

    for (const item of toolsVal) {
      if (!item || typeof item !== 'object') continue;

      // Find `function` object inside each tools[] item
      if (item.function && typeof item.function === 'object' && !Array.isArray(item.function)) {
        sanitizeNameDesc(item.function);
      } else if (typeof item.name === 'string' || typeof item.description === 'string') {
        // Handle cases where fields are at the root level
        sanitizeNameDesc(item);
      }
    }

    return toolsVal;
  };

  const walk = (node, depth) => {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (depth > maxDepth) return node;

    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        node[i] = walk(node[i], depth + 1);
      }
      return node;
    }

    // plain object
    const keysToTruncate = ['content', 'text', 'systemInstructions'];
    for (const [key, val] of Object.entries(node)) {
      if (keysToTruncate.includes(key) && typeof val === 'string') {
        node[key] = truncateStr(val, maxLen);
        continue;
      }

      if (key === 'tools') {
        node[key] = sanitizeToolsArray(val);
        // still traverse into it (but depth-limited) in case there are nested content fields, etc.
        node[key] = walk(node[key], depth + 1);
        continue;
      }

      node[key] = walk(val, depth + 1);
    }
    return node;
  };

  return walk(value, 0);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlightJson(jsonText) {
  if (!jsonText) return '';
  if (typeof jsonLexer !== 'function') return escapeHtml(jsonText);
  let tokens;
  try {
    tokens = jsonLexer(jsonText);
  } catch (_) {
    return escapeHtml(jsonText);
  }
  return tokens.map((token, idx) => highlightToken(token, idx, tokens)).join('');
}

function highlightToken(token, index, tokens) {
  const raw = escapeHtml(token.raw);
  switch (token.type) {
    case 'whitespace':
      return raw;
    case 'punctuator':
      return `<span class="json-punctuation">${raw}</span>`;
    case 'string': {
      const cls = isKeyToken(index, tokens) ? 'json-key' : 'json-string';
      return `<span class="${cls}">${raw}</span>`;
    }
    case 'number':
      return `<span class="json-number">${raw}</span>`;
    case 'literal': {
      const cls = token.value === null ? 'json-null' : 'json-boolean';
      return `<span class="${cls}">${raw}</span>`;
    }
    default:
      return raw;
  }
}

function isKeyToken(index, tokens) {
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    const candidate = tokens[cursor];
    if (candidate.type === 'whitespace') continue;
    return candidate.type === 'punctuator' && candidate.value === ':';
  }
  return false;
}

function formatCellWithMeta(v) {
  if (v === null || v === undefined) return {text: '', isJson: false};

  // If it's already an object/array, truncate content fields in-place and pretty-print as JSON
  if (typeof v === 'object') {
    const sanitized = truncateContentDeep(v, 3, 200);
    return {text: JSON.stringify(sanitized, null, 2), isJson: true};
  }

  // If it's a string, try to parse JSON; if JSON, truncate then pretty-print
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {text: '', isJson: false};

    // keep your heuristic (fast) or parse-always; this keeps the heuristic:
    if (s[0] === '{' || s[0] === '[') {
      try {
        const parsed = JSON.parse(s);
        const sanitized = truncateContentDeep(parsed, 3, 200);
        return {text: JSON.stringify(sanitized, null, 2), isJson: true};
      } catch (_) {
        // not JSON
      }
    }

    return {text: s, isJson: false};
  }

  return {text: String(v), isJson: false};
}

function stopWatch() {
  try { fileWatcher?.close(); } catch (_) {}
  fileWatcher = null;
}

function debounceRefresh(delay = 300) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadPreview();
  }, delay);
}

// ... existing code ...

function renderRows(data) {
  logsBody.innerHTML = '';
  data.forEach(item => {
    const tr = document.createElement('tr');
    // make the row visually and interactively clickable
    tr.classList.add('clickable-row');
    tr.tabIndex = 0; // make focusable for keyboard users
    const parsed = item.parsed;
    const timeCell = document.createElement('td');
    timeCell.textContent = (parsed && parsed.timestamp) ? new Date(parsed.timestamp).toLocaleString() : '';
    const levelCell = document.createElement('td');
    levelCell.textContent = parsed && parsed.level ? parsed.level : '';
    levelCell.className = parsed && parsed.level ? 'level-' + parsed.level : '';
    const eventCell = document.createElement('td');
    eventCell.textContent = parsed && parsed.eventType ? parsed.eventType : '';
    const msgCell = document.createElement('td');
    msgCell.textContent = (parsed && parsed.message) ? parsed.message : item.raw;
    const moreCell = document.createElement('td');
    // Create a <details> element in the last column but render the expanded
    // content as a separate table row that spans all columns so it appears
    // below the current row instead of nested inside the cell.
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'fields';
    details.appendChild(summary);

    // Source value for the expanded row:
    // Prefer showing parsed.fields (this is the "fields" column), then fall back.
    const expandValue =
      (parsed && Object.prototype.hasOwnProperty.call(parsed, 'fields'))
        ? parsed.fields
        : (parsed || item.raw);

    const copyToClipboard = async (text) => {
      // Best effort: Clipboard API, with execCommand fallback.
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) {}

      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.left = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) {
        return false;
      }
    };

    details.addEventListener('toggle', () => {
      // When opened, insert a new <tr> with a single <td colspan=5>
      if (details.open) {
        const expandTr = document.createElement('tr');
        expandTr.className = 'expanded-row';
        const td = document.createElement('td');
        // set colspan dynamically to match current number of columns
        td.colSpan = tr.children.length || 1;

            // Add a copy button above the formatted <pre>
            const toolbar = document.createElement('div');
            toolbar.style.display = 'flex';
            toolbar.style.justifyContent = 'flex-end';
            toolbar.style.gap = '8px';
            toolbar.style.margin = '6px 0';

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.textContent = 'Copy';
            copyBtn.title = 'Copy formatted content';

            const pre = document.createElement('pre');
            pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

            const {text, isJson} = formatCellWithMeta(expandValue);
            if (isJson) {
              pre.classList.add('code-json');
              pre.innerHTML = highlightJson(text);
            } else {
              pre.classList.remove('code-json');
              pre.textContent = text;
            }

            copyBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              e.stopPropagation(); // avoid toggling details/row
              const ok = await copyToClipboard(text);
              const prev = copyBtn.textContent;
              copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
              copyBtn.disabled = true;
              setTimeout(() => {
                copyBtn.textContent = prev;
                copyBtn.disabled = false;
              }, 900);
            });

            toolbar.appendChild(copyBtn);

            td.appendChild(toolbar);
            td.appendChild(pre);

        expandTr.appendChild(td);

        // store a reference so we can remove it when closed
        details._expandRow = expandTr;
        // insert after the current row
        if (tr.parentNode) tr.parentNode.insertBefore(expandTr, tr.nextSibling);
      } else {
        // remove the expanded row
        if (details._expandRow && details._expandRow.parentNode) {
          details._expandRow.parentNode.removeChild(details._expandRow);
          details._expandRow = null;
        }
      }
    });

    moreCell.appendChild(details);

    // Clicking anywhere on the row (except inside the details area)
    // should toggle the details open/closed. We ignore clicks that
    // originate from inside the details so we don't double-toggle.
    tr.addEventListener('click', (e) => {
      // If the click target is inside this details element, do nothing
      if (e.target.closest && e.target.closest('details') === details) return;
      details.open = !details.open;
    });

    // Keyboard support: Enter or Space toggles the details when focused
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // Prevent scrolling for Space
        e.preventDefault();
        if (e.target.closest && e.target.closest('details') === details) return;
        details.open = !details.open;
      }
    });
    tr.appendChild(timeCell);
    tr.appendChild(levelCell);
    tr.appendChild(eventCell);
    tr.appendChild(msgCell);
    tr.appendChild(moreCell);
    logsBody.appendChild(tr);
  });
}

function startWatch(file) {
	stopWatch();
	if (!file) return;
	try {
		const es = new EventSource(
			`/api/watch?file=${encodeURIComponent(file)}`,
		);
		es.onmessage = e => {
			try {
				const evt = JSON.parse(e.data);
				if (evt && evt.type === 'change') {
					debounceRefresh(250);
				}
			} catch (_) {}
		};
		es.onerror = () => {
			// close and retry soon on error
			stopWatch();
			setTimeout(() => startWatch(file), 2000);
		};
		fileWatcher = es;
	} catch (_) {
		// ignore; manual refresh still works
	}
}

function renderFiles(files) {
	fileListEl.innerHTML = '';
	files.forEach(f => {
		const li = document.createElement('li');
		li.textContent = `${f.name} — ${f.size} bytes`;
		li.title = `mtime: ${new Date(f.mtime).toLocaleString()}`;
		li.addEventListener('click', () => {
			selectFile(f.name);
		});
		fileListEl.appendChild(li);
	});
}

async function loadFiles() {
	const res = await fetch('/api/files');
	const list = await res.json();
	renderFiles(list.filter(f => f.isFile));
}

async function selectFile(name) {
  selectedFile = name;
  info.textContent = `Loading ${name}...`;
  logsTable.hidden = true;
  // set up auto-refresh watcher for this file
  stopWatch();
  startWatch(name);
  await loadPreview();
}

function applyFilters(rows) {
  const level = levelFilter.value.trim();
  const search = searchInput.value.trim().toLowerCase();
  return rows.filter(r => {
    const p = r.parsed;
    if (level) {
      if (!p || !p.level || p.level !== level) return false;
    }
    if (search) {
      const hay = (r.raw + ' ' + JSON.stringify(p || {})).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

async function loadPreview() {
  if (!selectedFile) return;
  const lines = Number(linesInput.value) || 200;
  const res = await fetch(`/api/preview?file=${encodeURIComponent(selectedFile)}&lines=${lines}`);
  if (!res.ok) {
    info.textContent = `Error loading ${selectedFile}: ${res.statusText}`;
    return;
  }
  const body = await res.json();
  const rows = applyFilters(body.data);
  renderRows(rows);
  info.textContent = `Showing ${rows.length} / ${body.lines} lines from ${selectedFile}`;
  logsTable.hidden = false;
}

refreshBtn.addEventListener('click', () => {
  if (selectedFile) loadPreview(); else loadFiles();
});

levelFilter.addEventListener('change', () => { loadPreview(); });
searchInput.addEventListener('keyup', () => { loadPreview(); });

// initial
loadFiles();

// cleanup on unload
window.addEventListener('beforeunload', () => { stopWatch(); });
