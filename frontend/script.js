// script.js - frontend for SmartFuzzer UI (scan + load response-parameter inspector)
// Assumptions:
// - /crawl POST endpoint exists for scanning (same as earlier).
// - /api/responses GET endpoint returns JSON { responsesDir, fileCount, aggregate, perFile } as described earlier.

(() => {
  // --- DOM refs ---
  const scanForm = document.getElementById('scanForm');
  const urlInput = document.getElementById('url');
  const timeoutInput = document.getElementById('timeout');
  const headlessInput = document.getElementById('headless');
  const allowNonLocalInput = document.getElementById('allowNonLocal');
  const maxEndpointsInput = document.getElementById('maxEndpoints');
  const scanBtn = document.getElementById('scanBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');
  const formsCount = document.getElementById('formsCount');
  const linksCount = document.getElementById('linksCount');
  const networkCount = document.getElementById('networkCount');
  const mainResults = document.getElementById('mainResults');
  const rawJson = document.getElementById('rawJson');
  const downloadBtn = document.getElementById('downloadBtn');

  // create Load Responses button and place next to Download JSON
  const loadResponsesBtn = document.createElement('button');
  loadResponsesBtn.textContent = 'Load Response Params';
  loadResponsesBtn.className = 'btn secondary';
  loadResponsesBtn.type = 'button';
  // place in the controls area (adjacent to downloadBtn)
  downloadBtn.parentNode.insertBefore(loadResponsesBtn, downloadBtn.nextSibling);

  let latestResult = null;

  function setStatus(s, color) {
    statusEl.textContent = s;
    statusEl.style.background = color || '';
  }

  function prettyJSON(obj) {
    try { return JSON.stringify(obj, null, 2); } catch(e) { return String(obj); }
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"'`]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]));
  }

  // --- existing scan code (lightweight) ---
  async function doScan(e) {
    e && e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return alert('Enter a URL');

    setStatus('scanning...', 'linear-gradient(90deg,#f59e0b,#f97316)');
    mainResults.innerHTML = '';
    rawJson.textContent = 'Waiting for response...';

    const body = {
      url,
      headless: !!headlessInput.checked,
      timeoutMs: Number(timeoutInput.value) || 60000,
      allowNonLocal: !!allowNonLocalInput.checked,
      maxEndpoints: Number(maxEndpointsInput.value) || 200
    };

    try {
      scanBtn.disabled = true;
      clearBtn.disabled = true;

      const API_BASE = location.origin.includes('file:') ? 'http://localhost:5001' : `${location.protocol}//${location.hostname}:5001`;
      const resp = await fetch(`${API_BASE}/crawl`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const txt = await resp.text();
        setStatus('error', 'linear-gradient(90deg,#fb7185,#ef4444)');
        rawJson.textContent = `Server error: ${resp.status} ${resp.statusText}\n\n${txt}`;
        return;
      }

      const data = await resp.json();
      latestResult = data;
      setStatus('done', 'linear-gradient(90deg,#10b981,#34d399)');
      renderCrawlResults(data);
    } catch (err) {
      console.error(err);
      setStatus('failed', 'linear-gradient(90deg,#fb7185,#ef4444)');
      rawJson.textContent = 'Request failed: ' + (err.message || err);
    } finally {
      scanBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

  function renderCrawlResults(data) {
    // counts
    const counts = data.counts || {};
    formsCount.textContent = counts.forms ?? (data.forms ? data.forms.length : '—');
    linksCount.textContent = counts.links ?? (data.links ? data.links.length : '—');
    networkCount.textContent = counts.networkRequests ?? (data.endpoints ? data.endpoints.length : '—');

    rawJson.textContent = prettyJSON(data);

    // simple forms/endpoints display
    mainResults.innerHTML = '';

    const forms = data.forms || [];
    const endpoints = data.endpoints || [];

    const fsec = document.createElement('section');
    fsec.innerHTML = '<h3>Forms</h3>';
    if (forms.length === 0) {
      fsec.appendChild(Object.assign(document.createElement('p'), { textContent: 'No forms found.', className: 'muted' }));
    } else {
      const t = document.createElement('table');
      t.innerHTML = '<thead><tr><th>#</th><th>Action</th><th>Method</th><th>Inputs</th></tr></thead>';
      const tbody = document.createElement('tbody');
      forms.forEach((f, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td class="mono">${escapeHtml(f.action||f.template||f.url||'')}</td><td>${escapeHtml(f.method||'GET')}</td><td>${(f.params||f.inputs||[]).length}</td>`;
        tbody.appendChild(tr);
      });
      t.appendChild(tbody);
      fsec.appendChild(t);
    }
    mainResults.appendChild(fsec);

    const esec = document.createElement('section');
    esec.style.marginTop = '12px';
    esec.innerHTML = '<h3>Endpoints</h3>';
    if (endpoints.length === 0) {
      esec.appendChild(Object.assign(document.createElement('p'), { textContent: 'No endpoints observed.', className: 'muted' }));
    } else {
      const t = document.createElement('table');
      t.innerHTML = '<thead><tr><th>#</th><th>Method</th><th>URL</th><th>Params</th></tr></thead>';
      const tbody = document.createElement('tbody');
      endpoints.forEach((e, i) => {
        const paramsText = (e.params || []).map(p => p.name || '?').join(', ') || '-';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td>${escapeHtml(e.method||'GET')}</td><td class="mono">${escapeHtml(e.url||e.action||'')}</td><td>${escapeHtml(paramsText)}</td>`;
        tbody.appendChild(tr);
      });
      t.appendChild(tbody);
      esec.appendChild(t);
    }
    mainResults.appendChild(esec);
  }

  // download JSON
  downloadBtn.addEventListener('click', () => {
    if (!latestResult) return alert('No data to download');
    const blob = new Blob([JSON.stringify(latestResult, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crawler_result.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // clear
  clearBtn.addEventListener('click', () => {
    mainResults.innerHTML = '';
    rawJson.textContent = 'No data yet';
    formsCount.textContent = '—';
    linksCount.textContent = '—';
    networkCount.textContent = '—';
    setStatus('idle', '');
    latestResult = null;
  });

  scanForm.addEventListener('submit', doScan);
  setStatus('idle', '');

  // -----------------------------
  // Response-params inspector
  // -----------------------------
  async function loadResponseParams() {
    try {
      loadResponsesBtn.disabled = true;
      loadResponsesBtn.textContent = 'Loading...';
      const resp = await fetch('/api/responses');
      if (!resp.ok) {
        const txt = await resp.text();
        alert('Failed to load responses: ' + resp.status + ' ' + resp.statusText + '\n' + txt);
        return;
      }
      const data = await resp.json();
      renderResponseParams(data);
    } catch (err) {
      console.error(err);
      alert('Error loading responses: ' + (err.message || err));
    } finally {
      loadResponsesBtn.disabled = false;
      loadResponsesBtn.textContent = 'Load Response Params';
    }
  }

  function renderResponseParams(data) {
    mainResults.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'summary';
    header.innerHTML = `<div class="pill">Responses dir: ${escapeHtml(data.responsesDir || '')}</div>
                        <div class="pill">Files: ${data.fileCount || 0}</div>`;
    mainResults.appendChild(header);

    // Aggregate table
    const aggSection = document.createElement('section');
    aggSection.style.marginTop = '12px';
    aggSection.innerHTML = '<h3>Aggregated Parameters</h3>';
    const filter = document.createElement('input');
    filter.placeholder = 'Filter parameter name...';
    filter.className = 'small';
    filter.style.marginBottom = '8px';
    aggSection.appendChild(filter);

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Parameter</th><th>Count</th><th>Details</th></tr></thead>';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    aggSection.appendChild(table);
    mainResults.appendChild(aggSection);

    // Per-file section
    const fileSection = document.createElement('section');
    fileSection.style.marginTop = '12px';
    fileSection.innerHTML = '<h3>Per-file parameters</h3>';
    const filesContainer = document.createElement('div');
    fileSection.appendChild(filesContainer);
    mainResults.appendChild(fileSection);

    // store data for detail view
    const agg = data.aggregate || [];
    const perFile = data.perFile || [];
    let shownAgg = agg;

    function populateAgg(list) {
      tbody.innerHTML = '';
      list.forEach(item => {
        const tr = document.createElement('tr');
        const nameCell = document.createElement('td');
        nameCell.className = 'mono';
        nameCell.textContent = item.name;
        const countCell = document.createElement('td');
        countCell.textContent = item.count;
        const actionsCell = document.createElement('td');
        const openBtn = document.createElement('button');
        openBtn.className = 'link-btn';
        openBtn.textContent = 'Show';
        openBtn.addEventListener('click', () => showOccurrences(item));
        actionsCell.appendChild(openBtn);

        tr.appendChild(nameCell);
        tr.appendChild(countCell);
        tr.appendChild(actionsCell);
        tbody.appendChild(tr);
      });
    }

    populateAgg(shownAgg);

    // filter input
    filter.addEventListener('input', (ev) => {
      const q = ev.target.value.toLowerCase().trim();
      shownAgg = agg.filter(x => x.name.toLowerCase().includes(q));
      populateAgg(shownAgg);
    });

    // populate per-file list
    filesContainer.innerHTML = '';
    perFile.forEach(f => {
      const card = document.createElement('div');
      card.style.borderBottom = '1px solid rgba(0,0,0,0.06)';
      card.style.padding = '8px 0';
      const h = document.createElement('h4');
      h.textContent = f.file;
      card.appendChild(h);
      if (!f.params || f.params.length === 0) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No params found';
        card.appendChild(p);
      } else {
        const ul = document.createElement('ul');
        f.params.forEach(p => {
          const li = document.createElement('li');
          li.innerHTML = `<strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.type)}) - <small>${escapeHtml(JSON.stringify(p.meta))}</small>`;
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }
      filesContainer.appendChild(card);
    });
  }

  function showOccurrences(item) {
    // simple modal-like details panel (append to mainResults)
    const detail = document.createElement('div');
    detail.className = 'card';
    detail.style.marginTop = '12px';
    const h = document.createElement('h3');
    h.textContent = `Occurrences for "${item.name}"`;
    detail.appendChild(h);

    item.occurrences.forEach(o => {
      const d = document.createElement('div');
      d.style.borderTop = '1px solid rgba(0,0,0,0.04)';
      d.style.padding = '8px 0';
      d.innerHTML = `<strong>File:</strong> ${escapeHtml(o.file)} — <strong>type:</strong> ${escapeHtml(o.type)}<pre class="raw" style="margin-top:6px">${escapeHtml(JSON.stringify(o.meta, null, 2))}</pre>`;
      detail.appendChild(d);
    });

    // close button
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.className = 'btn secondary';
    close.style.marginTop = '8px';
    close.addEventListener('click', () => {
      detail.remove();
    });
    detail.appendChild(close);

    // insert detail panel at top of mainResults
    mainResults.insertBefore(detail, mainResults.firstChild);
    // scroll to top of results
    mainResults.scrollIntoView({ behavior: 'smooth' });
  }

  // attach load responses button handler
  loadResponsesBtn.addEventListener('click', loadResponseParams);

  // also allow auto-load if URL has ?viewResponses=1
  if (new URLSearchParams(window.location.search).get('viewResponses') === '1') {
    loadResponseParams();
  }

})();
