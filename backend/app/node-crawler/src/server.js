// node-crawler/src/server.js
/**
 * Advanced Node crawler (Playwright + Express) and Pipeline Orchestrator
 * * Flow: /crawl -> server.js(Crawl) -> param_type_pipeline.py -> payload_gen.py -> run_raw_cmds.sh
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const fs = require("fs");
const path = require("path");
// ADDED: For executing external Python/Bash scripts
const { execSync } = require('child_process');
const app = express();
const SCRIPTS_ROOT = process.env.SCRIPTS_ROOT
  ? path.resolve(process.env.SCRIPTS_ROOT)
  : path.resolve(__dirname, '..', '..', '..'); // adjust upward levels to reach backend root

// convenience alias (optional)
const SCRIPTS_DIR = SCRIPTS_ROOT;

// Example resolved paths (use path.join for segments)
const MODEL_PATH = path.resolve(SCRIPTS_DIR, 'app', 'node-crawler', 'src', 'param_type_model.joblib');
const PAYLOAD_LIB_PATH = path.resolve(SCRIPTS_DIR, 'app', 'ml', 'payload_library.json');
const TEMPLATE_INPUT_FILE = path.resolve(SCRIPTS_DIR, 'app', 'node-crawler', 'src', 'param_templates.json');
const TEMPLATE_OUTPUT_FILE = path.resolve(SCRIPTS_DIR, 'app', 'node-crawler', 'src', 'param_templates_with_predicted_types.json');
const PAYLOAD_OUTPUT_FILE = path.resolve(SCRIPTS_DIR, 'app', 'node-crawler', 'src', 'payloads_vulners.txt');

// Python / Bash script paths (relative-to-root style)
const PARAM_TYPE_SCRIPT_PATH = path.resolve(SCRIPTS_DIR, 'app', 'node-crawler', 'src', 'param_type_pipeline.py');
// If payload_gen.py is located in the ml folder as you said, build it like this:
const PAYLOAD_GEN_SCRIPT_PATH = path.resolve(SCRIPTS_DIR, 'app', 'ml', 'payload_gen.py');
// And the executor script:
const EXEC_SCRIPT_PATH = path.resolve(SCRIPTS_DIR, 'app', 'ml', 'run_raw_cmds.sh');

// ---------- Option B: Direct absolute assignment (explicit) ----------
// If you prefer to hardcode the absolute path, include the leading slash and use path.resolve to normalize.
const PAYLOAD_GEN_ABS = path.resolve('/home/arunexploit/develop/Smartfuzzier/backend/app/ml/payload_gen.py');
const EXEC_SCRIPT_ABS    = path.resolve('/home/arunexploit/develop/Smartfuzzier/backend/app/ml/run_raw_cmds.sh');

// ---------- Choose which one to use ----------
// For example, prefer the env override if present, otherwise default to Option A:
const finalPayloadGenPath = process.env.PAYLOAD_GEN_SCRIPT_PATH ? path.resolve(process.env.PAYLOAD_GEN_SCRIPT_PATH) : PAYLOAD_GEN_SCRIPT_PATH;
const finalExecScriptPath = process.env.EXEC_SCRIPT_PATH ? path.resolve(process.env.EXEC_SCRIPT_PATH) : EXEC_SCRIPT_PATH;

// ---------- Sanity-check helper (fail early with clear error) ----------
function requireFile(p, friendlyName) {
  if (!fs.existsSync(p)) {
    const msg = `${friendlyName || 'File'} not found: ${p}\n` +
                `Set the correct path or provide env var (e.g. PAYLOAD_GEN_SCRIPT_PATH).`;
    // Log and throw so you see the problem immediately
    console.error(msg);
    throw new Error(msg);
  }
  return p;
}

// Example checks (uncomment the ones you want enforced)
requireFile(finalPayloadGenPath, 'payload_gen.py');
requireFile(finalExecScriptPath, 'run_raw_cmds.sh');
// requireFile(MODEL_PATH, 'param_type_model.joblib'); // optional: only if model must exist
// requireFile(PAYLOAD_LIB_PATH, 'payload_library.json'); // optional

// Expose or export for other modules if this is a config file
module.exports = {
  SCRIPTS_ROOT,
  SCRIPTS_DIR,
  MODEL_PATH,
  PAYLOAD_LIB_PATH,
  TEMPLATE_INPUT_FILE,
  TEMPLATE_OUTPUT_FILE,
  PAYLOAD_OUTPUT_FILE,
  PARAM_TYPE_SCRIPT_PATH,
  finalPayloadGenPath,
  finalExecScriptPath,
};

app.use(express.json({ limit: '2mb' }));
app.use(cors()); // during development; restrict origin in production

// Helper: normalize URL (remove fragment)
function normalizeUrl(u) {
  try {
    const nu = new URL(u);
    nu.hash = '';
    // remove trailing slash except root
    if (nu.pathname !== '/' && nu.pathname.endsWith('/')) {
      nu.pathname = nu.pathname.replace(/\/*$/,'');
    }
    return nu.toString();
  } catch (e) {
    return u; // return raw if can't parse
  }
}

// resilient navigation helper
async function resilientGoto(page, targetUrl, opts = {}) {
  const baseTimeout = Number(opts.timeoutMs || 30000);
  const tryOrder = opts.tryOrder || ['networkidle', 'load', 'domcontentloaded'];

  for (const mode of tryOrder) {
    try {
      await page.goto(targetUrl, { waitUntil: mode, timeout: baseTimeout });
      // short grace wait for late XHRs
      await page.waitForTimeout(opts.postWaitMs || 800);
      return { ok: true, method: mode };
    } catch (err) {
      // try next mode
      if (mode === tryOrder[tryOrder.length - 1]) {
        try {
          const content = await page.content();
          return { ok: false, lastError: String(err), content };
        } catch (e) {
          return { ok: false, lastError: String(err) };
        }
      }
      // small backoff and retry next mode
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return { ok: false, lastError: 'unreachable' };
}

// utility: extract query param keys from a URL string
function extractQueryKeys(u) {
  try {
    const p = new URL(u);
    return Array.from(p.searchParams.keys());
  } catch (e) {
    return [];
  }
}

app.post('/crawl', async (req, res) => {
  const body = req.body || {};
  const targetUrl = (body.url || '').trim();
  if (!targetUrl) return res.status(400).json({ error: 'Missing "url" in request body' });

  // Options (with safe defaults)
  const headless = body.headless === undefined ? true : Boolean(body.headless);
  const timeoutMs = Number(body.timeoutMs || 60000);
  const allowNonLocal = Boolean(body.allowNonLocal || false);
  const systemChromePath = body.systemChromePath || null;
  const maxEndpoints = Math.max(50, Math.min(1000, Number(body.maxEndpoints || 200))); // clamp
  const blockedResourceTypes = Array.isArray(body.blockResourceTypes) ? body.blockResourceTypes : ['image','stylesheet','font','media'];
  const restrictToHost = !allowNonLocal;

  // Safety check: only allow non-local targets if explicitly allowed
  try {
    const parsedTarget = new URL(targetUrl);
    const host = parsedTarget.hostname;
    const isLocal = (host === 'localhost' || host === '127.0.0.1' || host === '::1');
    if (!isLocal && !allowNonLocal) {
      return res.status(403).json({ error: 'Target host is non-local. To allow non-local scanning set allowNonLocal=true and ensure you have permission.' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  let browser;
  try {
    // Launch browser (optionally using system Chrome)
    const launchOpts = { headless, args: ['--no-sandbox'] };
    if (systemChromePath) launchOpts.executablePath = systemChromePath;
    browser = await chromium.launch(launchOpts);

    const page = await browser.newPage({ ignoreHTTPSErrors: true });

    // Set a friendly user agent + viewport to reduce bot detection
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36');
      await page.setViewportSize({ width: 1280, height: 800 });
    } catch (_) {}

    // Set up resource blocking / routing to reduce noise and speed up
    await page.route('**/*', route => {
      try {
        const req = route.request();
        const rt = req.resourceType();
        // abort noisy resource types
        if (blockedResourceTypes.includes(rt)) return route.abort();
        return route.continue();
      } catch (e) {
        return route.continue();
      }
    });

    // Collections for results
    const targetHost = (new URL(targetUrl)).host;
    const networkRequests = []; 
    const networkResponses = new Map(); 
    const linksSeen = new Set();

    // Capture requests and responses
    page.on('request', r => {
      try {
        const u = r.url();
        if (!u || u.startsWith('data:') || u.startsWith('about:')) return;
        const parsed = new URL(u);
        if (restrictToHost && parsed.host !== targetHost) return;
        if (blockedResourceTypes.includes(r.resourceType())) return;

        networkRequests.push({
          url: normalizeUrl(u),
          method: r.method(),
          hasPostData: !!r.postData(),
          resourceType: r.resourceType()
        });
      } catch (e) {}
    });

    page.on('response', resp => {
      try {
        const ru = normalizeUrl(resp.url());
        networkResponses.set(ru + '|' + resp.status(), resp.status());
      } catch (e) {}
    });

    // Navigate with resilient helper
    const navResult = await resilientGoto(page, targetUrl, { timeoutMs, postWaitMs: 800, tryOrder: ['networkidle','load','domcontentloaded'] });
    if (!navResult.ok) {
      console.warn('Navigation fallback:', navResult.lastError || navResult.method);
    }

    // DOM extraction: forms + links
    const dom = await page.evaluate(() => {
      // ... (existing form and link extraction logic) ...
      function normalizeInput(i) {
        const tag = i.tagName.toLowerCase();
        const typeAttr = (i.getAttribute('type') || '').toLowerCase();
        const type = typeAttr || (tag === 'textarea' ? 'textarea' : 'text');
        if (['submit','button','reset','image'].includes(type)) return null;
        const param = {
          name: i.getAttribute('name') || null,
          type,
          required: i.hasAttribute('required')
        };
        if (tag === 'select') {
          param.options = Array.from(i.options).map(o => o.value || o.text);
        }
        if (!param.name && type !== 'hidden') return null;
        return param;
      }

      const forms = [];
      document.querySelectorAll('form').forEach(f => {
        const action = f.getAttribute('action') || window.location.href;
        const method = (f.getAttribute('method') || 'GET').toUpperCase();
        const params = [];
        f.querySelectorAll('input,select,textarea').forEach(i => {
          try {
            const p = normalizeInput(i);
            if (p) params.push(p);
          } catch (e) {}
        });
        if (params.length > 0) forms.push({ action, method, params });
      });

      const rawLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (href) rawLinks.push(href);
      });

      const scripts = Array.from(document.scripts || []).map(s => s.innerText || '');
      const combined = scripts.join('\n').slice(0, 20000);
      const hints = [];
      try {
        const regex = /\/[A-Za-z0-9_\-\/]*api[A-Za-z0-9_\-\/]*/gi;
        let m;
        while ((m = regex.exec(combined))) hints.push(m[0]);
        if (combined.includes('fetch(') || combined.includes('axios')) hints.push('uses fetch/axios');
      } catch(e) {}

      return { forms, rawLinks, hints: Array.from(new Set(hints)) };
    });

    // Normalize extracted links to absolute URLs & extract query keys
    const pageUrl = (await page.url()) || targetUrl;
    dom.rawLinks.forEach(l => {
      try {
        const abs = new URL(l, pageUrl).toString();
        linksSeen.add(abs);
      } catch (e) {}
    });

    // Build endpoint list: combine forms, links (GET with query keys), network requests
    const endpointsMap = new Map();

    function addEndpoint(obj) {
      try {
        const method = (obj.method || 'GET').toUpperCase();
        const urln = normalizeUrl(obj.url || obj.action || obj.href);
        const key = method + '|' + urln;
        if (endpointsMap.has(key)) {
          const existing = endpointsMap.get(key);
          if (obj.params && Array.isArray(obj.params)) {
            existing.params = existing.params || [];
            for (const p of obj.params) {
              if (!existing.params.find(x => x.name === p.name)) existing.params.push(p);
            }
          }
          if (obj.hasPostData) existing.hasPostData = existing.hasPostData || obj.hasPostData;
          endpointsMap.set(key, existing);
        } else {
          endpointsMap.set(key, Object.assign({}, obj, { url: urln, method }));
        }
      } catch (e) {}
    }

    // add forms
    for (const f of dom.forms) {
      try {
        const abs = new URL(f.action, pageUrl).toString();
        addEndpoint({ action: abs, method: f.method, params: f.params });
      } catch (e) {}
    }

    // add links (GET)
    for (const l of linksSeen) {
      const params = extractQueryKeys(l);
      addEndpoint({ url: l, method: 'GET', params: params.map(k => ({ name: k, type: 'string', required: false })) });
    }

    // add network requests
    for (const nr of networkRequests) {
      addEndpoint({ url: nr.url, method: nr.method, hasPostData: nr.hasPostData, params: extractQueryKeys(nr.url).map(k => ({ name: k, type: 'string', required: false })) });
    }

    // add inline hints (best-effort)
    try {
      for (const h of dom.hints || []) {
        try {
          const abs = new URL(h, pageUrl).toString();
          addEndpoint({ url: abs, method: 'GET', note: 'inline_hint' });
        } catch (e) {}
      }
    } catch (e) {}

    // Annotate endpoints with last seen status if available
    for (const [k, ep] of endpointsMap.entries()) {
      for (const [statusKey, status] of networkResponses.entries()) {
        if (statusKey.startsWith(ep.url)) {
          ep.status = Number(status);
          break;
        }
      }
    }

    // Limit number of endpoints returned to maxEndpoints
    const endpoints = Array.from(endpointsMap.values()).slice(0, maxEndpoints);

    // finalize forms
    const normalizedForms = dom.forms.map(f => {
      try {
        const abs = new URL(f.action, pageUrl).toString();
        return { action: normalizeUrl(abs), method: f.method, params: f.params || [] };
      } catch (e) {
        return { action: f.action, method: f.method, params: f.params || [] };
      }
    });

    await browser.close();

    const responseData = {
      url: targetUrl,
      navigatedTo: pageUrl,
      navigation: navResult,
      counts: {
        forms: normalizedForms.length,
        endpoints: endpoints.length,
        links: linksSeen.size,
        networkRequests: networkRequests.length
      },
      forms: normalizedForms,
      endpoints
    };

    // ----------------------------------------------------------
    // STEP 1 (Cont.): Write Crawl Results (Input for ML)
    // ----------------------------------------------------------
    // FIX: Using the configured TEMPLATE_INPUT_FILE path for consistency with Python scripts
    try {
      fs.writeFileSync(TEMPLATE_INPUT_FILE, JSON.stringify(responseData, null, 2));
      console.log(`\n[1/4] Crawler output written to ${TEMPLATE_INPUT_FILE}`);
    } catch (err) {
      console.error("[1/4] ERROR: Failed to write crawl output file:", err);
      return res.status(500).json({ error: "Failed to write crawl output file for pipeline processing." });
    }
    
    // ----------------------------------------------------------
    // STEP 2: PARAMETER TYPE PREDICTION (param_type_pipeline.py)
    // ----------------------------------------------------------
    const paramTypeCmd = `python3 ${PARAM_TYPE_SCRIPT_PATH} --input ${TEMPLATE_INPUT_FILE} --model ${MODEL_PATH} --predict --output ${TEMPLATE_OUTPUT_FILE}`;
    console.log(`[2/4] Running Parameter Prediction: ${paramTypeCmd}`);
    
    try {
        execSync(paramTypeCmd, { stdio: 'inherit' });
        console.log(`[2/4] Parameter Prediction Complete. Types saved to ${TEMPLATE_OUTPUT_FILE}`);
    } catch (e) {
        console.error(`[2/4] ERROR: Param type pipeline failed. Falling back to use raw input data. Error: ${e.message}`);
        // Fallback: copy the initial file if prediction fails
        fs.copyFileSync(TEMPLATE_INPUT_FILE, TEMPLATE_OUTPUT_FILE);
    }

    // ----------------------------------------------------------
    // STEP 3: PAYLOAD GENERATION (payload_gen.py)
    // ----------------------------------------------------------
    const payloadGenCmd = `python3 ${PAYLOAD_GEN_SCRIPT_PATH} --param_file ${TEMPLATE_OUTPUT_FILE} --payload_file ${PAYLOAD_LIB_PATH} --output_path ${PAYLOAD_OUTPUT_FILE}`;
    console.log(`[3/4] Running Payload Generation: ${payloadGenCmd}`);
    
    try {
        execSync(payloadGenCmd, { stdio: 'inherit' });
        console.log(`[3/4] Payload Generation Complete. Commands saved to ${PAYLOAD_OUTPUT_FILE}`);
    } catch (e) {
        console.error(`[3/4] ERROR: Payload generation failed. Error: ${e.message}`);
        return res.status(500).json({ 
            ...responseData, 
            error: "Payload generation failed. Check Python script logs."
        });
    }


    // ----------------------------------------------------------
    // STEP 4: COMMAND EXECUTION (run_raw_cmds.sh)
    // ----------------------------------------------------------
    // NOTE: Passing PAYLOAD_OUTPUT_FILE path to the bash script via the INFILE environment variable.
    const execCmd = `bash ${EXEC_SCRIPT_PATH}`;
    console.log(`[4/4] Running Raw Command Execution: ${execCmd}`);
    
    try {
        execSync(execCmd, { 
            stdio: 'inherit',
            env: { ...process.env, INFILE: PAYLOAD_OUTPUT_FILE } 
        });
        console.log(`[4/4] Command Execution Complete. Responses saved to a new output directory.`);
    } catch (e) {
        console.error(`[4/4] ERROR: Command execution failed. Response data may not be saved. Error: ${e.message}`);
    }
    
    // ----------------------------------------------------------
    // FINAL RESPONSE
    // ----------------------------------------------------------
    return res.json(responseData);

  } catch (err) {
    // ensure browser closed
    try { if (browser) await browser.close(); } catch (e) {}
    return res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Node crawler listening on port ${PORT}`));