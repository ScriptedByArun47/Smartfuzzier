// src/App.jsx
import React, { useState } from "react";
import axios from "axios";
import "./styles.css";

function ScanForm({ onResult, setLoading }) {
  const [url, setUrl] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return alert("Enter a URL");
    try {
      setLoading(true);
      // you can add other options here (headless, timeoutMs, allowNonLocal, etc.)
      const resp = await axios.post(
        "http://localhost:5001/crawl",
        { url },
        { timeout: 120000 }
      );
      onResult(resp.data);
    } catch (err) {
      console.error(err);
      alert("Scan failed: " + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="scan-form" onSubmit={submit}>
      <input
        type="text"
        placeholder="Enter target URL (lab only, e.g. http://testphp.vulnweb.com/login.php)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="url-input"
      />
      <button type="submit" className="btn">Scan</button>
    </form>
  );
}

/** Helper: render a param (supports older 'inputs' shape and newer 'params' shape) */
function renderParamRow(param, idx) {
  // param might be string (name) or object { name, type, required, options }
  if (!param) return null;
  const name = typeof param === "string" ? param : param.name || "<unnamed>";
  const type = typeof param === "string" ? "string" : param.type || "string";
  const required = typeof param === "string" ? false : Boolean(param.required);
  const options = param.options || null;
  return (
    <tr key={idx}>
      <td>{name}</td>
      <td>{type}</td>
      <td>{required ? "yes" : "no"}</td>
      <td>{options ? (Array.isArray(options) ? options.join(", ") : String(options)) : "-"}</td>
    </tr>
  );
}

function Results({ data }) {
  const [expanded, setExpanded] = useState(null);
  if (!data) return null;

  // support different shapes: server may return forms[].params or forms[].inputs
  const forms = (data.forms || []).map(f => {
    if (f.params && Array.isArray(f.params)) return f;
    if (f.inputs && Array.isArray(f.inputs)) {
      // map inputs -> params: keep name,type,required,options if present
      const params = f.inputs
        .map(i => {
          if (!i) return null;
          return {
            name: i.name ?? i.get?.name ?? null,
            type: i.type ?? (i.tag === "textarea" ? "textarea" : "text"),
            required: !!i.required,
            options: i.options ?? null
          };
        })
        .filter(Boolean);
      return { action: f.action, method: f.method, params };
    }
    return { action: f.action, method: f.method, params: [] };
  });

  // endpoints: params may be array of objects or missing
  const endpoints = data.endpoints || [];

  const counts = data.counts || { forms: forms.length, links: "-", networkRequests: endpoints.length };

  return (
    <div className="results">
      <h2>Scan result for: <code>{data.url}</code></h2>
      <div className="summary">
        <span>Forms: {counts.forms ?? forms.length}</span>
        <span>Links: {counts.links ?? "–"}</span>
        <span>Network Requests: {counts.networkRequests ?? endpoints.length}</span>
      </div>

      <section>
        <h3>Forms</h3>
        {forms.length === 0 ? <p>No forms found.</p> :
          <table className="results-table">
            <thead>
              <tr><th>#</th><th>Action</th><th>Method</th><th>Param count</th><th>Details</th></tr>
            </thead>
            <tbody>
              {forms.map((f, i) => (
                <React.Fragment key={i}>
                  <tr className="row-main">
                    <td>{i}</td>
                    <td className="mono">{f.action}</td>
                    <td>{f.method}</td>
                    <td>{(f.params || []).length}</td>
                    <td>
                      <button className="link-btn" onClick={() => setExpanded(expanded === `form-${i}` ? null : `form-${i}`)}>
                        {expanded === `form-${i}` ? "Hide" : "Show"}
                      </button>
                    </td>
                  </tr>

                  {expanded === `form-${i}` && (
                    <tr className="row-expand">
                      <td colSpan={5}>
                        <div className="expand-grid">
                          <div className="panel">
                            <h4>Parameters</h4>
                            <table className="small-table">
                              <thead>
                                <tr><th>Name</th><th>Type</th><th>Required</th><th>Options</th></tr>
                              </thead>
                              <tbody>
                                {(f.params || []).map((p, k) => renderParamRow(p, k))}
                              </tbody>
                            </table>
                          </div>

                          <div className="panel">
                            <h4>Raw JSON</h4>
                            <pre className="raw">{JSON.stringify(f, null, 2)}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        }
      </section>

      <section style={{ marginTop: 20 }}>
        <h3>Network / Endpoints</h3>
        {endpoints.length === 0 ? <p>No network endpoints observed.</p> :
          <table className="results-table">
            <thead><tr><th>#</th><th>Method</th><th>URL</th><th>Params</th><th>Notes</th></tr></thead>
            <tbody>
              {endpoints.map((e, i) => {
                // e.params might be array of objects or array of names
                const paramList = (e.params || []).map(p => (typeof p === "string" ? p : p.name || JSON.stringify(p))).join(", ");
                return (
                  <tr key={i}>
                    <td>{i}</td>
                    <td>{e.method}</td>
                    <td className="mono">{e.url}</td>
                    <td>{paramList || "-"}</td>
                    <td>{e.note || (e.hasPostData ? "POST body" : (e.status ? `status:${e.status}` : ""))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }
      </section>

      <section style={{ marginTop: 20 }}>
        <h3>Full JSON</h3>
        <pre className="raw">{JSON.stringify(data, null, 2)}</pre>
      </section>
    </div>
  );
}

export default function App() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="app">
      <header><h1>SmartFuzzer — Stage 1 Viewer</h1></header>
      <main>
        <ScanForm onResult={setResult} setLoading={setLoading} />
        {loading ? <div className="loading">Scanning…</div> : <Results data={result} />}
      </main>
      <footer>Lab-only tool — do not scan external sites without permission.</footer>
    </div>
  );
}
