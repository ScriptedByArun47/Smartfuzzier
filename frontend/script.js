(() => {
  const API_BASE = location.origin.includes('file:') ? 'http://localhost:5001' : `${location.protocol}//${location.hostname}:5001`;
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

  let latestResult = null;

  function setStatus(s, color) {
    statusEl.textContent = s;
    statusEl.style.background = color ? color : '';
  }

  function prettyJSON(obj) {
    try { return JSON.stringify(obj, null, 2); } catch(e) { return String(obj); }
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"'`]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]));
  }

  function buildCurlExample(obj, placeholderName, placeholderToken) {
    const url = obj.template || obj.url || obj.action || '';
    const method = (obj.method || 'GET').toUpperCase();
    const p = encodeURIComponent(`${placeholderToken}`);
    if (method === 'GET') {
      if (url.includes('$' + placeholderName + '$')) {
        const curlUrl = url.replace('$' + placeholderName + '$', p);
        return `curl -G "${curlUrl}"`;
      } else {
        const sep = url.includes('?') ? '&' : '?';
        return `curl -G "${url}${sep}${placeholderName}=${p}"`;
      }
    } else {
      return `curl -X POST "${url}" -d "${placeholderName}=${placeholderToken}&_=${Date.now()}"`;
    }
  }

  function renderInputsTableHtml(form) {
    const inputs = form.params || form.inputs || [];
    if (!inputs.length) return '<div class="muted">No inputs discovered</div>';
    let html = '<table class="small-table" style="width:100%"><thead><tr><th>Tag</th><th>Name</th><th>Type</th><th>Required</th></tr></thead><tbody>';
    inputs.forEach(inp => {
      html += `<tr><td>${escapeHtml(inp.tag || '-')}</td><td class="mono">${escapeHtml(inp.name || '<unnamed>')}</td><td>${escapeHtml(inp.type || (inp.param_type || '-'))}</td><td>${inp.required ? 'yes' : 'no'}</td></tr>`;
    });
    html += '</tbody></table>';
    return html;
  }

  function renderResults(data) {
    latestResult = data;
    const counts = data.counts || {};
    formsCount.textContent = counts.forms ?? (data.forms ? data.forms.length : '—');
    linksCount.textContent = counts.links ?? (data.links ? data.links.length : '—');
    networkCount.textContent = counts.networkRequests ?? (data.endpoints ? data.endpoints.length : '—');

    rawJson.textContent = prettyJSON(data);
    mainResults.innerHTML = '';

    const forms = data.forms || [];
    const endpoints = data.endpoints || [];

    // Forms Section
    const formsSection = document.createElement('section');
    const fsH = document.createElement('h3'); fsH.textContent = 'Forms';
    formsSection.appendChild(fsH);

    if (forms.length === 0) {
      const p = document.createElement('p'); p.textContent = 'No forms found.'; p.className = 'muted';
      formsSection.appendChild(p);
    } else {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>#</th><th>Action</th><th>Method</th><th>Inputs</th><th>Details</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');

      forms.forEach((f, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td class="mono">${escapeHtml(f.action || f.template || f.url || '')}</td><td>${f.method}</td><td>${(f.params||f.inputs||[]).length}</td><td><button class="link-btn" data-toggle="form-${i}">Show</button></td>`;
        tbody.appendChild(tr);

        const expand = document.createElement('tr');
        expand.style.display = 'none';
        expand.id = `form-${i}`;
        expand.innerHTML = `<td colspan="5">
          <div class="panel-grid">
            <div>
              <h4>Inputs</h4>
              ${renderInputsTableHtml(f)}
            </div>
            <div>
              <h4>Examples</h4>
              <div class="curl">${escapeHtml(buildCurlExample(f, ((f.params||[])[0] && (f.params||[])[0].name) || 'param', '[BASELINE]'))}</div>
              <div style="margin-top:10px" class="muted">Raw JSON:</div>
              <pre class="raw">${escapeHtml(JSON.stringify(f, null, 2))}</pre>
            </div>
          </div>
        </td>`;
        tbody.appendChild(expand);
      });
      table.appendChild(tbody);
      formsSection.appendChild(table);
    }

    mainResults.appendChild(formsSection);

    // Endpoints Section
    const endpointsSection = document.createElement('section');
    endpointsSection.style.marginTop = '16px';
    const epH = document.createElement('h3'); epH.textContent = 'Network / Endpoints';
    endpointsSection.appendChild(epH);

    if (endpoints.length === 0) {
      const p = document.createElement('p'); p.textContent = 'No network endpoints observed.'; p.className = 'muted';
      endpointsSection.appendChild(p);
    } else {
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>#</th><th>Method</th><th>URL</th><th>Params</th><th>Notes</th></tr></thead>';
      const tbody = document.createElement('tbody');
      endpoints.forEach((e, i) => {
        const paramsText = (e.params || []).map(p => p.name || '?').join(', ') || '-';
        const note = (e.hasPostData ? 'POST body' : '') + (e.status ? ` • ${e.status}` : '');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td>${e.method || 'GET'}</td><td class="mono">${escapeHtml(e.url || e.action || '')}</td><td>${escapeHtml(paramsText)}</td><td>${escapeHtml(note)}</td>`;
        tbody.appendChild(tr);

        const expand = document.createElement('tr');
        expand.innerHTML = `<td colspan="5">
          <div style="display:flex; gap:12px; align-items:flex-start">
            <div style="flex:1">
              <pre class="raw">${escapeHtml(JSON.stringify(e, null, 2))}</pre>
            </div>
            <div style="width:360px">
              <div><strong>Example curl</strong></div>
              <div class="curl">${escapeHtml(buildCurlExample(e, (e.params && e.params[0] && e.params[0].name) || 'param', '[PLACEHOLDER]'))}</div>
            </div>
          </div>
        </td>`;
        tbody.appendChild(expand);
      });
      table.appendChild(tbody);
      endpointsSection.appendChild(table);
    }

    mainResults.appendChild(endpointsSection);

    document.querySelectorAll('.link-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle');
        const tr = document.getElementById(id);
        if (!tr) return;
        tr.style.display = (tr.style.display === 'none' || tr.style.display === '') ? '' : 'none';
        btn.textContent = (btn.textContent === 'Show') ? 'Hide' : 'Show';
      });
    });
  }

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
      setStatus('done', 'linear-gradient(90deg,#10b981,#34d399)');
      renderResults(data);
    } catch (err) {
      console.error(err);
      setStatus('failed', 'linear-gradient(90deg,#fb7185,#ef4444)');
      rawJson.textContent = 'Request failed: ' + (err.message || err);
    } finally {
      scanBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

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
})();
