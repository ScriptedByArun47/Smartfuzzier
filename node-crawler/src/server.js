// node-crawler/src/server.js
/**
 * Advanced Node crawler (Playwright + Express)
 *
 * Features:
 *  - resilient navigation (networkidle -> load -> domcontentloaded fallback)
 *  - resource blocking (images/fonts/styles etc.) to reduce noise
 *  - same-host filtering by default (set allowNonLocal=true to allow other hosts)
 *  - extracts: forms (action, method, params{name,type,required,options}), links (with query keys)
 *  - captures network requests (method, postData present) and response status
 *  - normalizes & dedupes endpoints
 *  - configurable via POST body:
 *      { url, headless=true, timeoutMs=60000, allowNonLocal=false, systemChromePath=null, maxEndpoints=200 }
 *
 * Safety note: This is for lab/authorized testing only. By default non-local hosts are blocked.
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors()); // during development; restrict origin in production

// Helper: normalize URL (remove fragment)
function normalizeUrl(u) {
  try {
    const nu = new URL(u);
    nu.hash = '';
    // remove trailing slash except root
    if (nu.pathname !== '/' && nu.pathname.endsWith('/')) {
      nu.pathname = nu.pathname.replace(/\/+$/,'');
    }
    return nu.toString();
  } catch (e) {
    return u; // return raw if can't parse
  }
}

// resilient navigation helper
async function resilientGoto(page, targetUrl, opts = {}) {
  const baseTimeout = Number(opts.timeoutMs || 30000);
  // (blockers should be set up by caller before calling this if desired)
  const tryOrder = opts.tryOrder || ['networkidle', 'load', 'domcontentloaded'];

  for (const mode of tryOrder) {
    try {
      await page.goto(targetUrl, { waitUntil: mode, timeout: baseTimeout });
      // short grace wait for late XHRs (configurable)
      await page.waitForTimeout(opts.postWaitMs || 800);
      return { ok: true, method: mode };
    } catch (err) {
      // try next mode
      // if last mode, return failure object but include page content if possible
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
    const networkRequests = []; // { url, method, hasPostData, resourceType }
    const networkResponses = new Map(); // url -> status (last seen)
    const linksSeen = new Set();

    // Capture requests and responses
    page.on('request', r => {
      try {
        const u = r.url();
        // filter out data: and about:
        if (!u || u.startsWith('data:') || u.startsWith('about:')) return;
        // optional same-host restriction
        const parsed = new URL(u);
        if (restrictToHost && parsed.host !== targetHost) return;
        // skip blocked resource types (already aborted but double-check)
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
      // continue — we will still attempt extraction from partial content
      console.warn('Navigation fallback:', navResult.lastError || navResult.method);
    }

    // DOM extraction: forms + links
    const dom = await page.evaluate(() => {
      // extract forms
      function normalizeInput(i) {
        const tag = i.tagName.toLowerCase();
        const typeAttr = (i.getAttribute('type') || '').toLowerCase();
        const type = typeAttr || (tag === 'textarea' ? 'textarea' : 'text');

        // ignore non-params
        if (['submit','button','reset','image'].includes(type)) return null;

        const param = {
          name: i.getAttribute('name') || null,
          type,
          required: i.hasAttribute('required') // boolean
        };

        if (tag === 'select') {
          param.options = Array.from(i.options).map(o => o.value || o.text);
        }
        // skip unnamed unless hidden
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

      // extract links (hrefs)
      const rawLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (href) rawLinks.push(href);
      });

      // inline JS hints (simple) - look for "/api" occurrences in scripts or fetch/axios tokens
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
    const endpointsMap = new Map(); // key -> endpoint object

    function addEndpoint(obj) {
      try {
        const method = (obj.method || 'GET').toUpperCase();
        const urln = normalizeUrl(obj.url || obj.action || obj.href);
        const key = method + '|' + urln;
        if (endpointsMap.has(key)) {
          // merge info (e.g., params)
          const existing = endpointsMap.get(key);
          if (obj.params && Array.isArray(obj.params)) {
            existing.params = existing.params || [];
            // merge param names without duplicates
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
        // try resolve relative hint
        try {
          const abs = new URL(h, pageUrl).toString();
          addEndpoint({ url: abs, method: 'GET', note: 'inline_hint' });
        } catch (e) {}
      }
    } catch (e) {}

    // Annotate endpoints with last seen status if available
    for (const [k, ep] of endpointsMap.entries()) {
      // try to find any matching status recorded
      for (const [statusKey, status] of networkResponses.entries()) {
        // statusKey = normalizeUrl + '|' + status
        if (statusKey.startsWith(ep.url)) {
          ep.status = Number(status);
          break;
        }
      }
    }

    // Limit number of endpoints returned to maxEndpoints (preserve priority by insertion order)
    const endpoints = Array.from(endpointsMap.values()).slice(0, maxEndpoints);

    // finalize forms to include normalized action + params with required flag and option values
    const normalizedForms = dom.forms.map(f => {
      try {
        const abs = new URL(f.action, pageUrl).toString();
        return { action: normalizeUrl(abs), method: f.method, params: f.params || [] };
      } catch (e) {
        return { action: f.action, method: f.method, params: f.params || [] };
      }
    });

    await browser.close();

    const responseData ={
      url: targetUrl,
      navigatedTo: pageUrl,
      navigation: navResult,
      counts:{
        forms:normalizedForms.length,
        links: linksSeen.size,
        networkRequests:networkRequests.length
      },
      forms: normalizedForms,
      endpoints

    };
    try{
      const filePath =path.join(__dirname, "param_templates.json");
      fs.writeFileSync(filePath,JSON.stringify(responseData, null, 2));
      console.log(`Response data written to ${filePath}`);
    
      
    }
    catch(err){
      console.error("Error writing to file:", err);
    }
    return res.json(responseData);

  } catch (err) {
    // ensure browser closed
    try { if (browser) await browser.close(); } catch (e) {}
    return res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Node crawler listening on port ${PORT}`));
