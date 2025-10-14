// script.js - frontend for SmartFuzzer UI (scan + load response-parameter inspector)
// Assumptions:
// - /crawl POST endpoint exists for scanning (same as earlier).
// - /api/latest-results GET endpoint returns JSON with fuzzing results.

(() => {
  // ----------------------------------------------------------------------
  // FIX: Define the full URL for the Node.js API server (usually Port 5001)
  // CHANGE THIS IF YOUR NODE SERVER RUNS ON A DIFFERENT HOST/PORT
  const API_BASE_URL = 'http://localhost:5001'; 
  // ----------------------------------------------------------------------

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

  // NEW DOM refs for Results Viewer
  const scanSection = document.getElementById('scanSection');
  const resultsSection = document.getElementById('resultsSection');
  const showScanBtn = document.getElementById('showScanBtn');
  const showResultsBtn = document.getElementById('showResultsBtn');
  const resultsSummary = document.getElementById('resultsSummary');
  const resultsContainer = document.getElementById('resultsContainer');
  const resultsDirName = document.getElementById('resultsDirName');

  // --- Utility ---
  function setStatus(text, type = 'idle') {
    statusEl.textContent = text;
    statusEl.className = 'pill ' + type;
  }

  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // --- Core Scan Logic ---
  scanForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Scanning...', 'pending');
    scanBtn.disabled = true;

    // Reset crawl-related counts
    formsCount.textContent = '—';
    linksCount.textContent = '—';
    networkCount.textContent = '—';
    mainResults.innerHTML = '';
    rawJson.textContent = 'No data yet';
    
    try {
      // MODIFIED: Use API_BASE_URL for the /crawl endpoint
      const response = await fetch(`${API_BASE_URL}/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.value,
          timeoutMs: Number(timeoutInput.value),
          headless: headlessInput.checked,
          allowNonLocal: allowNonLocalInput.checked,
          maxEndpoints: Number(maxEndpointsInput.value)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus(`Error: ${data.error || response.statusText}`, 'danger');
        return;
      }

      setStatus('Scan & Fuzz Complete (Check Results Tab)', 'ok');
      
      // Update crawl results display
      formsCount.textContent = data.counts.forms;
      linksCount.textContent = data.counts.links;
      networkCount.textContent = data.counts.networkRequests;
      rawJson.textContent = JSON.stringify(data, null, 2);
      
      // Render Endpoints
      mainResults.innerHTML = '';
      data.endpoints.forEach(ep => {
        const p = document.createElement('p');
        p.className = 'curl';
        p.style.marginBottom = '6px';
        p.innerHTML = `<strong>${ep.method}</strong>: <a href="${escapeHtml(ep.url)}" target="_blank">${escapeHtml(ep.url)}</a>` + 
                      (ep.params && ep.params.length > 0 ? ` <em>(${ep.params.length} params)</em>` : '');
        mainResults.appendChild(p);
      });

    } catch (error) {
      // This is the error you were seeing, now hopefully fixed by using the full URL
      setStatus('Network Error. Is the Node server running?', 'danger');
      console.error('Fetch error:', error);
    } finally {
      scanBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', () => {
    setStatus('idle');
    formsCount.textContent = '—';
    linksCount.textContent = '—';
    networkCount.textContent = '—';
    mainResults.innerHTML = '';
    rawJson.textContent = 'No data yet';
    resultsContainer.innerHTML = ''; // Clear results view as well
    resultsSummary.textContent = 'Awaiting scan or result data...';
    resultsDirName.textContent = '';
  });

  downloadBtn.addEventListener('click', () => {
    const data = rawJson.textContent;
    if (data && data !== 'No data yet') {
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'crawl_results.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  });

  // --- View Switching ---
  function showView(view) {
    if (view === 'scan') {
      scanSection.style.display = 'block';
      resultsSection.style.display = 'none';
      showScanBtn.classList.add('primary', 'selected');
      showScanBtn.classList.remove('secondary');
      showResultsBtn.classList.remove('primary', 'selected');
      showResultsBtn.classList.add('secondary');
    } else if (view === 'results') {
      scanSection.style.display = 'none';
      resultsSection.style.display = 'block';
      showResultsBtn.classList.add('primary', 'selected');
      showResultsBtn.classList.remove('secondary');
      showScanBtn.classList.remove('primary', 'selected');
      showScanBtn.classList.add('secondary');
      loadLatestResults(); // Load data when switching to results view
    }
  }

  showScanBtn.addEventListener('click', () => showView('scan'));
  showResultsBtn.addEventListener('click', () => showView('results'));
  
  // Start on scan view
  showView('scan');


  // --- Results Viewer Logic ---

  /**
   * Creates a collapsible card for a single request/response result.
   */
  function createResultCard(result) {
    const card = document.createElement('div');
    card.className = 'response-card';
    
    // Status pill based on HTTP code
     let statusClass = 'pill';
    if (result.status.startsWith('2')) statusClass += ' ok';
    else if (result.status.startsWith('3')) statusClass += ' secondary';
    else if (result.status.startsWith('4')) statusClass += ' danger';
    else if (result.status.startsWith('5')) statusClass += ' danger';

    card.innerHTML = `
        <details>
            <summary class="flex-between">
                <div>
                    <span class="${statusClass}">${result.status}</span>
                    <strong style="margin-left: 10px;">${result.fileName.toUpperCase()}</strong>
                    <span class="muted" style="margin-left: 15px;">cURL Command:</span>
                    <code class="curl" style="display:inline-block; font-size: 11px; max-width: 500px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${escapeHtml(result.curlCommand)}</code>
                </div>
            </summary>
            <div class="panel-grid">
                <div>
                    <h4>HTTP Response (Headers + Body)</h4>
                    <pre class="raw" style="max-height: 400px; overflow-x: auto;">${escapeHtml(result.html)}</pre>
                    ${result.error ? `
                        <h4>cURL Error Output</h4>
                        <pre class="raw danger-text" style="max-height: 100px;">${escapeHtml(result.error)}</pre>
                    ` : ''}
                </div>
               
            </div>
        </details>
    `;
    return card;
  }

  /**
   * Fetches the latest results from the server and renders them.
   */
  async function loadLatestResults() {
    resultsSummary.textContent = 'Loading latest results...';
    resultsContainer.innerHTML = '';
    resultsDirName.textContent = '...';

    try {
        // MODIFIED: Use API_BASE_URL for the /api/latest-results endpoint
        const response = await fetch(`${API_BASE_URL}/api/latest-results`);
        const data = await response.json();

        if (data.error) {
            resultsSummary.textContent = `Error loading results: ${data.error}`;
            return;
        }
        
        resultsDirName.textContent = data.directory || 'N/A';

        if (data.results.length === 0) {
            resultsSummary.textContent = data.message || 'No fuzzing results available yet. Run a scan first.';
            return;
        }

        resultsSummary.textContent = `${data.results.length} responses loaded from the latest run in directory: ${data.directory}`;
        
        data.results.forEach(result => {
            const card = createResultCard(result);
            resultsContainer.appendChild(card);
        });

    } catch (error) {
        resultsSummary.textContent = 'Network or API error while fetching results.';
        console.error('Error fetching latest results:', error);
    }
  }

})();