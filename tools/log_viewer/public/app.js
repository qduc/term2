const fileListEl = document.getElementById('files');
const logsTable = document.getElementById('logsTable');
const logsBody = document.getElementById('logsBody');
const info = document.getElementById('info');
const refreshBtn = document.getElementById('refresh');
const levelFilter = document.getElementById('levelFilter');
const searchInput = document.getElementById('search');
const linesInput = document.getElementById('lines');

let selectedFile = null;

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

function formatCell(v) {
  if (!v) return '';
  // If it's an object, pretty-print it with indentation for readability
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  // If it's a string, try to detect and parse JSON to pretty-print it
  if (typeof v === 'string') {
    const s = v.trim();
    // quick heuristic: valid JSON often starts with { or [
    if (s && (s[0] === '{' || s[0] === '[')) {
      try {
        const parsed = JSON.parse(s);
        return JSON.stringify(parsed, null, 2);
      } catch (err) {
        // not JSON — fall through and return raw string
      }
    }
  }
  return String(v);
}

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

    // Formatted content for the expanded row
    const formatted = formatCell(parsed || item.raw);

    details.addEventListener('toggle', () => {
      // When opened, insert a new <tr> with a single <td colspan=5>
      if (details.open) {
        const expandTr = document.createElement('tr');
        expandTr.className = 'expanded-row';
        const td = document.createElement('td');
        // set colspan dynamically to match current number of columns
        td.colSpan = tr.children.length || 1;
        const pre = document.createElement('pre');
        pre.textContent = formatted;
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

async function selectFile(name) {
  selectedFile = name;
  info.textContent = `Loading ${name}...`;
  logsTable.hidden = true;
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
