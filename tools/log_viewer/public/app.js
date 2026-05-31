const fileListEl = document.getElementById('files');
const fileSearchInput = document.getElementById('fileSearch');
const clearFileSearchBtn = document.getElementById('clearFileSearch');
const collapseAllBtn = document.getElementById('collapseAllFiles');
const logsTable = document.getElementById('logsTable');
const logsBody = document.getElementById('logsBody');
const info = document.getElementById('info'); // Empty state container
const headerTitle = document.getElementById('currentFileName');
const headerMeta = document.getElementById('fileMeta');

const refreshBtn = document.getElementById('refresh');
const advancedFiltersBtn = document.getElementById('advancedFiltersBtn');
const advancedFiltersPanel = document.getElementById('advancedFiltersPanel');

const levelFilter = document.getElementById('levelFilter');
const searchInput = document.getElementById('search');
const linesInput = document.getElementById('lines');
const presetFilter = document.getElementById('presetFilter');

// Advanced filters
const traceIdFilter = document.getElementById('traceIdFilter');
const sessionIdFilter = document.getElementById('sessionIdFilter');
const eventTypeFilter = document.getElementById('eventTypeFilter');
const toolNameFilter = document.getElementById('toolNameFilter');
const providerFilter = document.getElementById('providerFilter');
const modelFilter = document.getElementById('modelFilter');

let selectedFile = null;
let fileWatcher = null; // SSE watcher
let refreshTimer = null; // debounce timer for auto-refresh
let filterTimer = null; // debounce timer for search/filter redraw
let rowCache = [];
let fileOffset = 0;

const PRESET_MAP = {
  errors: { level: 'error' },
  tool_calls: { eventType: 'tool_call.' },
  invalid_tool_format: { eventType: 'tool_call.parse_failed' },
  retries: { eventType: 'retry.' },
};

// --- Utilities ---

function truncateContentDeep(value, maxDepth = 3, maxLen = 200) {
  const seen = new WeakSet();
  const truncateStr = (s, limit = maxLen) => (typeof s === 'string' && s.length > limit ? s.slice(0, limit) + '…' : s);

  const sanitizeToolsArray = (toolsVal) => {
    if (!Array.isArray(toolsVal)) return toolsVal;

    const sanitizeNameDesc = (obj) => {
      const name = typeof obj.name === 'string' ? obj.name : undefined;
      const description = truncateStr(typeof obj.description === 'string' ? obj.description : undefined, maxLen);
      // Remove all fields except name/description
      for (const key in obj) {
        if (key !== 'name' && key !== 'description') delete obj[key];
      }
      obj.name = name;
      obj.description = description;
      if (obj.name === undefined) delete obj.name;
      if (obj.description === undefined) delete obj.description;
    };

    for (const item of toolsVal) {
      if (!item || typeof item !== 'object') continue;
      if (item.function && typeof item.function === 'object' && !Array.isArray(item.function)) {
        sanitizeNameDesc(item.function);
      } else if (typeof item.name === 'string' || typeof item.description === 'string') {
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
  if (v === null || v === undefined) return { text: '', isJson: false };
  if (typeof v === 'object') {
    const sanitized = truncateContentDeep(v, 3, 200);
    return { text: JSON.stringify(sanitized, null, 2), isJson: true };
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return { text: '', isJson: false };
    if (s[0] === '{' || s[0] === '[') {
      try {
        const parsed = JSON.parse(s);
        const sanitized = truncateContentDeep(parsed, 3, 200);
        return { text: JSON.stringify(sanitized, null, 2), isJson: true };
      } catch (_) {}
    }
    return { text: s, isJson: false };
  }
  return { text: String(v), isJson: false };
}

// --- App Logic ---

function stopWatch() {
  try {
    fileWatcher?.close();
  } catch (_) {}
  fileWatcher = null;
}

function debounceRefresh(delay = 300) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    appendLatest();
  }, delay);
}

function renderRows(data) {
  logsBody.innerHTML = '';

  if (data.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `<td colspan="5" style="text-align:center; padding: 20px; color: var(--text-dim);">No logs match the current filters</td>`;
    logsBody.appendChild(emptyRow);
    return;
  }

  data.forEach((item) => {
    const tr = document.createElement('tr');
    tr.classList.add('clickable-row');
    tr.tabIndex = 0;

    const parsed = item.parsed;
    const isMalformed = !parsed;

    // Time Column
    const timeCell = document.createElement('td');
    timeCell.textContent =
      parsed && parsed.timestamp
        ? new Date(parsed.timestamp).toLocaleTimeString() +
          `.${new Date(parsed.timestamp).getMilliseconds().toString().padStart(3, '0')}`
        : '-';
    timeCell.title = parsed && parsed.timestamp ? new Date(parsed.timestamp).toLocaleString() : '';

    // Level Column
    const levelCell = document.createElement('td');
    if (parsed && parsed.level) {
      levelCell.textContent = parsed.level.toUpperCase();
      levelCell.className = 'level-' + parsed.level;
    } else if (isMalformed) {
      const badge = document.createElement('span');
      badge.textContent = 'PARSE';
      badge.className = 'badge-parse-error';
      levelCell.appendChild(badge);
    }

    // Event Type Column
    const eventCell = document.createElement('td');
    if (parsed && parsed.eventType) {
      eventCell.textContent = parsed.eventType;
    } else if (parsed && parsed.direction) {
      eventCell.textContent = String(parsed.direction).toUpperCase();
    }

    // Message Column
    const msgCell = document.createElement('td');
    // Truncate message for the table view
    const msgText =
      (parsed && parsed.message) || (parsed && parsed.sourceMessage) || (parsed && parsed.file) || item.raw;
    msgCell.textContent = msgText.length > 120 ? msgText.substring(0, 120) + '...' : msgText;
    msgCell.title = msgText;

    // Actions Column (Expand)
    const moreCell = document.createElement('td');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    details.appendChild(summary);

    const expandValue =
      parsed && Object.prototype.hasOwnProperty.call(parsed, 'fields') ? parsed.fields : parsed || item.raw;

    // Expand Logic
    details.addEventListener('toggle', () => {
      if (details.open) {
        const expandTr = document.createElement('tr');
        expandTr.className = 'expanded-row';
        const td = document.createElement('td');
        td.colSpan = 5;

        // Toolbar inside expanded row
        const toolbar = document.createElement('div');
        toolbar.className = 'expanded-toolbar';

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'expanded-actions';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-ghost';
        copyBtn.innerHTML = `Copy JSON`; // Simplified for brevity

        const traceBtn = document.createElement('button');
        traceBtn.className = 'btn btn-ghost';
        traceBtn.textContent = 'Ref Trace';
        traceBtn.title = 'Filter by this traceId';

        const pre = document.createElement('pre');
        const { text, isJson } = formatCellWithMeta(expandValue);

        if (isJson) {
          pre.classList.add('code-json');
          pre.innerHTML = highlightJson(text);
        } else {
          pre.textContent = text;
        }

        // Action Handlers
        const copyToClipboard = async (text) => {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
          }
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        };

        copyBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const ok = await copyToClipboard(text);
          const originalText = copyBtn.innerText;
          copyBtn.innerText = ok ? 'Copied!' : 'Failed';
          setTimeout(() => (copyBtn.innerText = originalText), 1000);
        };

        traceBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const traceId = parsed && parsed.traceId ? String(parsed.traceId) : '';
          if (traceId) {
            traceIdFilter.value = traceId;
            advancedFiltersPanel.classList.remove('hidden'); // Show styling
            debouncedFilterRender();
          }
        };

        if (parsed && parsed.traceId) actionsDiv.appendChild(traceBtn);
        actionsDiv.appendChild(copyBtn);
        toolbar.appendChild(actionsDiv);

        td.appendChild(toolbar);
        td.appendChild(pre);
        expandTr.appendChild(td);

        details._expandRow = expandTr;
        if (tr.parentNode) tr.parentNode.insertBefore(expandTr, tr.nextSibling);
      } else {
        if (details._expandRow && details._expandRow.parentNode) {
          details._expandRow.parentNode.removeChild(details._expandRow);
        }
      }
    });

    moreCell.appendChild(details);

    // Row Click Logic
    const toggleDetails = (e) => {
      if (e.target.closest && e.target.closest('details') === details) return;
      details.open = !details.open;
    };
    tr.addEventListener('click', toggleDetails);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDetails(e);
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
    const es = new EventSource(`/api/watch?file=${encodeURIComponent(file)}`);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt && evt.type === 'change') debounceRefresh(250);
      } catch (_) {}
    };
    es.onerror = () => {
      stopWatch();
      setTimeout(() => startWatch(file), 2000);
    };
    fileWatcher = es;
  } catch (_) {}
}

let allFiles = [];

function buildTree(files) {
  const root = { name: 'root', isDirectory: true, children: {}, filesCount: 0, path: '' };

  files.forEach((file) => {
    const parts = file.name.split('/');
    let current = root;
    current.filesCount++;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current.children[part] = {
          name: part,
          path: file.name,
          size: file.size,
          mtime: file.mtime,
          isFile: true,
        };
      } else {
        if (!current.children[part]) {
          const folderPath = current.path ? `${current.path}/${part}` : part;
          current.children[part] = {
            name: part,
            path: folderPath,
            isDirectory: true,
            children: {},
            filesCount: 0,
          };
        }
        current.children[part].filesCount++;
        current = current.children[part];
      }
    }
  });

  return root;
}

function renderTree(treeNode, container, depth = 0, autoExpand = false, searchQuery = '') {
  const keys = Object.keys(treeNode.children).sort((a, b) => {
    const nodeA = treeNode.children[a];
    const nodeB = treeNode.children[b];
    if (nodeA.isDirectory && !nodeB.isDirectory) return -1;
    if (!nodeA.isDirectory && nodeB.isDirectory) return 1;
    return a.localeCompare(b);
  });

  const pathParts = selectedFile ? selectedFile.split('/') : [];
  const parentPaths = [];
  let accumulated = '';
  for (let i = 0; i < pathParts.length - 1; i++) {
    accumulated = accumulated ? `${accumulated}/${pathParts[i]}` : pathParts[i];
    parentPaths.push(accumulated);
  }

  keys.forEach((key) => {
    const child = treeNode.children[key];
    const li = document.createElement('li');

    if (child.isDirectory) {
      li.className = 'folder-node';
      li.dataset.path = child.path;
      const folderId = `folder:${child.path}`;
      const isCollapsed = localStorage.getItem(folderId) === 'collapsed';
      const forceExpand = parentPaths.includes(child.path);

      if (autoExpand || forceExpand || !isCollapsed) {
        li.classList.add('expanded');
      }

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.style.paddingLeft = `${depth * 12 + 8}px`;

      header.innerHTML = `
        <span class="chevron">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </span>
        <span class="folder-icon-wrapper">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="folder-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </span>
        <span class="folder-name">${escapeHtml(child.name)}</span>
        <span class="file-count">${child.filesCount}</span>
      `;

      const ul = document.createElement('ul');
      ul.className = 'folder-children';

      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const expanded = li.classList.toggle('expanded');
        localStorage.setItem(folderId, expanded ? 'expanded' : 'collapsed');
      });

      li.appendChild(header);
      li.appendChild(ul);
      container.appendChild(li);

      renderTree(child, ul, depth + 1, autoExpand, searchQuery);
    } else {
      li.className = 'file-node';
      li.style.paddingLeft = `${depth * 12 + 24}px`;
      li.title = `Size: ${child.size} bytes\nModified: ${new Date(child.mtime).toLocaleString()}`;
      if (selectedFile === child.path) li.classList.add('active');

      li.innerHTML = `
        <span class="file-icon-wrapper">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="file-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        </span>
        <span class="file-name">${escapeHtml(child.name)}</span>
      `;

      li.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.file-list li.file-node').forEach((el) => el.classList.remove('active'));
        li.classList.add('active');
        selectFile(child.path);
      });

      container.appendChild(li);
    }
  });
}

function filterAndRenderFiles() {
  const query = fileSearchInput.value.trim().toLowerCase();
  if (query) {
    clearFileSearchBtn.classList.remove('hidden');
  } else {
    clearFileSearchBtn.classList.add('hidden');
  }

  const filtered = allFiles.filter((f) => f.name.toLowerCase().includes(query));
  fileListEl.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.style.textAlign = 'center';
    empty.style.color = 'var(--text-dim)';
    empty.style.padding = '12px';
    empty.style.fontSize = '12px';
    empty.textContent = 'No matching log files';
    fileListEl.appendChild(empty);
    return;
  }

  const tree = buildTree(filtered);
  renderTree(tree, fileListEl, 0, !!query, query);
}

function renderFiles(files) {
  allFiles = files;
  filterAndRenderFiles();
}

async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const list = await res.json();
    renderFiles(list.filter((f) => f.isFile));
  } catch (err) {
    console.error('Failed to load files', err);
  }
}

async function selectFile(name) {
  selectedFile = name;
  headerTitle.textContent = name;
  headerMeta.textContent = 'Loading...';

  info.parentElement.hidden = false; // Hide empty state
  info.hidden = true; // Use the viewer now
  logsTable.hidden = true;

  stopWatch();
  startWatch(name);
  await loadPreview();
}

function applyFilters(rows) {
  const selectedPreset = presetFilter.value || '';
  const preset = PRESET_MAP[selectedPreset] || {};
  const level = levelFilter.value.trim();
  const search = searchInput.value.trim().toLowerCase();

  // Advanced
  const traceId = traceIdFilter.value.trim();
  const sessionId = sessionIdFilter.value.trim();
  const eventType = eventTypeFilter.value.trim();
  const toolName = toolNameFilter.value.trim();
  const provider = providerFilter.value.trim();
  const model = modelFilter.value.trim();

  const effective = {
    level: level || preset.level || '',
    eventType: eventType || preset.eventType || '',
  };

  const matchesField = (value, expected) => {
    if (!expected) return true;
    if (!value) return false;
    if (expected.endsWith('.')) return String(value).startsWith(expected);
    return String(value) === expected;
  };

  return rows.filter((r) => {
    const p = r.parsed;
    if (!matchesField(p?.level, effective.level)) return false;
    if (!matchesField(p?.traceId, traceId)) return false;
    if (!matchesField(p?.sessionId, sessionId)) return false;
    if (!matchesField(p?.eventType, effective.eventType)) return false;
    if (!matchesField(p?.toolName, toolName)) return false;
    if (!matchesField(p?.provider, provider)) return false;
    if (!matchesField(p?.model, model)) return false;

    if (search) {
      const hay = (r.raw + ' ' + JSON.stringify(p || {})).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderFromCache() {
  const rows = applyFilters(rowCache);
  renderRows(rows);
  headerMeta.textContent = `${rows.length} / ${rowCache.length} lines shown`;
  logsTable.hidden = false;

  // Show/Hide empty state based on selection
  if (selectedFile) {
    info.style.display = 'none'; // Hide "Select a file..."
    logsTable.style.display = 'table';
  } else {
    info.style.display = 'flex';
    logsTable.style.display = 'none';
  }
}

function debouncedFilterRender(delay = 200) {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterTimer = null;
    renderFromCache();
  }, delay);
}

async function loadPreview() {
  if (!selectedFile) return;
  const lines = Number(linesInput.value) || 200;
  const res = await fetch(`/api/preview?file=${encodeURIComponent(selectedFile)}&lines=${lines}`);
  if (!res.ok) {
    headerMeta.textContent = `Error: ${res.statusText}`;
    return;
  }
  const body = await res.json();
  rowCache = Array.isArray(body.data) ? body.data : [];
  fileOffset = Number(body.offset) || 0;
  renderFromCache();
}

async function appendLatest() {
  if (!selectedFile) return;
  const res = await fetch(`/api/append?file=${encodeURIComponent(selectedFile)}&offset=${fileOffset}`);
  if (!res.ok) return;

  const body = await res.json();
  const appended = Array.isArray(body.data) ? body.data : [];
  if (body.reset) {
    await loadPreview();
    return;
  }

  if (appended.length > 0) {
    rowCache = [...appended.reverse(), ...rowCache]; // Prepend new items (if we show newest top) - logic seems to be newest top
  }
  fileOffset = Number(body.nextOffset) || fileOffset;
  renderFromCache();
}

// --- Event Listeners ---

refreshBtn.addEventListener('click', () => {
  if (selectedFile) loadPreview();
  else loadFiles();
});

advancedFiltersBtn.addEventListener('click', () => {
  advancedFiltersPanel.classList.toggle('hidden');
});

// Input listeners for real-time filtering
[
  levelFilter,
  searchInput,
  traceIdFilter,
  sessionIdFilter,
  eventTypeFilter,
  toolNameFilter,
  providerFilter,
  modelFilter,
  presetFilter,
].forEach((el) => {
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'keyup', () => debouncedFilterRender());
});

linesInput.addEventListener('change', () => {
  // Reload when lines count changes
  if (selectedFile) loadPreview();
});

// File search & collapse listeners
fileSearchInput.addEventListener('input', () => {
  filterAndRenderFiles();
});

clearFileSearchBtn.addEventListener('click', () => {
  fileSearchInput.value = '';
  filterAndRenderFiles();
});

collapseAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.folder-node').forEach((li) => {
    li.classList.remove('expanded');
    const path = li.dataset.path;
    if (path) {
      localStorage.setItem(`folder:${path}`, 'collapsed');
    }
  });
});

// --- Resizer Logic ---
const resizer = document.getElementById('resizer');
const sidebar = document.getElementById('sidebar');

let isResizing = false;

// Load persisted width
const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) {
  sidebar.style.width = savedWidth + 'px';
}

resizer.addEventListener('mousedown', (e) => {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  resizer.classList.add('dragging');
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;

  let newWidth = e.clientX;
  const minWidth = 150;
  const maxWidth = 600;

  if (newWidth < minWidth) newWidth = minWidth;
  if (newWidth > maxWidth) newWidth = maxWidth;

  sidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = 'default';
    resizer.classList.remove('dragging');
    localStorage.setItem('sidebarWidth', parseInt(sidebar.style.width));
  }
});

// Initial
loadFiles();
window.addEventListener('beforeunload', () => stopWatch());
