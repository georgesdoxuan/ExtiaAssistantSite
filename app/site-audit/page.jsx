"use client";

import { useMemo, useRef, useState } from "react";

function escapeForText(s) {
  return String(s ?? "");
}

export default function SiteAuditPage() {
  // First try same-origin Next.js API routes (no CORS), then fall back to direct API bases.
  const API_BASE_URLS = process.env.NEXT_PUBLIC_API_BASE_URL
    ? ["", process.env.NEXT_PUBLIC_API_BASE_URL]
    : ["", "http://localhost:3001", "http://localhost:3000"];

  const [update, setUpdate] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingAction, setLoadingAction] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [indexInfo, setIndexInfo] = useState(null);
  const [frenchOnly, setFrenchOnly] = useState(false);
  const auditAbortRef = useRef(null);

  function isMainFrenchPage(url) {
    try {
      const firstSeg = new URL(url).pathname.split("/").filter(Boolean)[0] || "";
      // Exclude any regional page (be-fr, ca-fr, fr-en, es-es, etc.)
      return !/^[a-z]{2}-[a-z]{2}$/.test(firstSeg);
    } catch { return true; }
  }

  const nav = [
    { href: "/", label: "Audit Mailchimp", active: false },
    { href: "/site-audit", label: "Audit site extia.fr", active: true }
  ];

  const allIssues = Array.isArray(result?.findings)
    ? result.findings.map((f) => ({
        severity: f?.severity || "low",
        category: f?.source?.category || "autre",
        url: f?.source?.url || "",
        title: f?.title || "",
        reason: f?.reason || "",
        evidence: f?.evidence || ""
      }))
    : (Array.isArray(result?.issues) ? result.issues : []);
  const issues = frenchOnly ? allIssues.filter((it) => isMainFrenchPage(it?.url || "")) : allIssues;

  async function callAcrossBases(path, options) {
    let lastErr;
    for (const b of API_BASE_URLS) {
      try {
        const target = b ? `${b}${path}` : path;
        const resp = await fetch(target, options);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || `Erreur API (${resp.status})`);
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("API indisponible");
  }

  async function refreshIndex() {
    setBusy(true);
    setLoadingAction("index");
    setError(null);
    setStatus("Indexation extia.fr en cours...");
    try {
      const data = await callAcrossBases("/api/site-index/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      setIndexInfo(data);
      setStatus("Indexation terminée.");
    } catch (e) {
      setError(e?.message || String(e));
      setStatus("Erreur.");
    } finally {
      setBusy(false);
      setLoadingAction("");
    }
  }

  async function runAudit() {
    const trimmed = String(update || "").trim();
    if (!trimmed) {
      setStatus("Veuillez saisir un changement.");
      return;
    }
    setBusy(true);
    setLoadingAction("audit");
    setError(null);
    setResult(null);
    setStatus("Assistant site en cours...");
    const controller = new AbortController();
    auditAbortRef.current = controller;
    try {
      const data = await callAcrossBases("/api/site-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: controller.signal
      });
      setResult(data);
      setStatus("Terminé.");
    } catch (e) {
      if (e?.name === "AbortError") {
        setStatus("Annulé.");
      } else {
        setError(e?.message || String(e));
        setStatus("Erreur.");
      }
    } finally {
      setBusy(false);
      setLoadingAction("");
      auditAbortRef.current = null;
    }
  }

  function cancelAudit() {
    if (loadingAction === "audit") {
      auditAbortRef.current?.abort();
    }
  }

  const catCount = useMemo(() => result?.snapshot_stats?.categories ?? indexInfo?.categories?.length ?? 0, [result, indexInfo]);

  return (
    <>
      <style>{`
        :root{ --bg:#f5f7fb; --card:rgba(255,255,255,0.9); --card2:rgba(255,255,255,0.72); --text:#111827; --muted:#6b7280; --border:#e5e7eb; --shadow:0 14px 40px rgba(17,24,39,0.08); }
        body{ margin:0; color:var(--text); min-height:100vh; background:radial-gradient(1000px 500px at 20% -10%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(900px 450px at 90% 0%, rgba(37,99,235,0.14), transparent 60%), var(--bg); font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
        .wrap{ max-width:1260px; margin:0 auto; padding:26px 18px 48px; }
        .layout{ display:grid; grid-template-columns:240px 1fr; gap:16px; align-items:start; }
        @media (max-width:980px){ .layout{ grid-template-columns:1fr; } }
        .sidebar,.card,.topbar{ border:1px solid var(--border); background:var(--card); border-radius:16px; box-shadow:var(--shadow); backdrop-filter: blur(8px); }
        .sidebar{ padding:12px; position:sticky; top:16px; }
        .navItem{ display:block; text-decoration:none; color:var(--text); border:1px solid transparent; padding:10px 12px; border-radius:12px; margin-bottom:8px; font-size:14px; }
        .navItem:hover{ background:#eef2ff; border-color:#dbeafe; transform: translateX(2px); } .navItem.active{ background:#eef2ff; border-color:#bfdbfe; font-weight:700; }
        .content{ min-width:0; }
        .topbar{ padding:18px; background:linear-gradient(135deg, rgba(124,58,237,0.16), rgba(37,99,235,0.1)); border-radius:18px; }
        .grid{ display:grid; grid-template-columns:1.1fr .9fr; gap:16px; margin-top:16px; } @media (max-width:900px){ .grid{ grid-template-columns:1fr; } }
        .card{ padding:16px; transition: transform .16s ease, box-shadow .16s ease; }
        .card:hover{ transform: translateY(-1px); box-shadow: 0 16px 44px rgba(17,24,39,0.11); }
        textarea{ width:100%; min-height:90px; max-height:180px; resize:none; overflow:auto; box-sizing:border-box; font-size:14px; line-height:1.35; border-radius:12px; padding:12px; border:1px solid var(--border); background:#fff; color:#111827; outline:none; font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-weight:400; }
        .actions{ display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap:wrap; }
        button{ padding:10px 14px; font-size:14px; cursor:pointer; border-radius:12px; border:1px solid rgba(255,255,255,0.18); background:linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.75)); color:#fff; font-weight:650; box-shadow: 0 8px 20px rgba(79,70,229,.22); transition: transform .12s ease, box-shadow .12s ease; }
        button:hover:not(:disabled){ transform: translateY(-1px); box-shadow: 0 12px 24px rgba(79,70,229,.28); }
        button:disabled{ cursor:not-allowed; opacity:.7; }
        .btn2{ background:rgba(17,24,39,.03); color:#111827; border-color:var(--border); }
        .btn-cancel{ background: linear-gradient(135deg, rgba(239,68,68,0.95), rgba(220,38,38,0.85)); border-color: rgba(239,68,68,0.28); color:#fff; }
        .muted{ color:var(--muted); font-size:13px; } .resultBox{ margin-top:14px; border:1px dashed rgba(17,24,39,.18); border-radius:14px; padding:14px; background:var(--card2); }
        .issue{ border:1px solid var(--border); border-radius:12px; background:#fff; padding:10px; margin-top:8px; }
        pre{ margin:0; white-space:pre-wrap; word-break:break-word; padding:10px 12px; border-radius:12px; border:1px solid var(--border); background:#f9fafb; font-size:13px; font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-weight:400; }
        .spinner{
          width:15px; height:15px; border-radius:999px; display:inline-block; vertical-align:-2px; margin-right:8px;
          border:2px solid rgba(255,255,255,.35); border-top-color: rgba(255,255,255,.95); animation:spin .8s linear infinite;
        }
        .spinnerDark{
          border:2px solid rgba(17,24,39,.2); border-top-color: rgba(17,24,39,.85);
        }
        .loaderFancy{
          margin-top:14px;
          border:1px dashed rgba(17,24,39,.18);
          border-radius:14px;
          padding:18px 14px;
          background: linear-gradient(135deg, rgba(124,58,237,0.08), rgba(37,99,235,0.06));
          display:flex;
          align-items:center;
          gap:12px;
        }
        .loaderOrb{
          width:22px; height:22px; border-radius:999px;
          border:3px solid rgba(37,99,235,.2);
          border-top-color: rgba(124,58,237,.95);
          animation:spin .8s linear infinite;
          box-shadow: 0 0 0 4px rgba(124,58,237,.1);
        }
        .loaderText{ font-size:13px; color:var(--muted); font-weight:600; }
        @keyframes spin{ to{ transform: rotate(360deg); } }
      `}</style>
      <div className="wrap">
        <div className="layout">
          <aside className="sidebar">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className={`navItem ${n.active ? "active" : ""}`}>{n.label}</a>
            ))}
          </aside>
          <div className="content">
            <div className="topbar">
              <h1 style={{ margin: 0, fontSize: 18 }}>Assistant site extia.fr ✨</h1>
              <div className="muted" style={{ marginTop: 6 }}>
                Posez une question sur les contenus du site. Reponse avec preuves URL en lecture seule.
              </div>
            </div>
            <div className="grid">
              <div className="card">
                <textarea value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="Ex: Trouve toutes les pages qui mentionnent encore les anciennes infos Great Place To Work." />
                <div className="actions">
                  <button className="btn2" onClick={refreshIndex} disabled={busy}>
                    {loadingAction === "index" ? <span className="spinner spinnerDark" /> : null}
                    {loadingAction === "index" ? "Indexation en cours..." : "Indexer extia.fr"}
                  </button>
                  <button onClick={loadingAction === "audit" ? cancelAudit : runAudit} disabled={busy && loadingAction !== "audit"} className={loadingAction === "audit" ? "btn-cancel" : ""}>
                    {loadingAction === "audit" ? <span className="spinner" /> : null}
                    {loadingAction === "audit" ? "Annuler" : "Envoyer a l'assistant site"}
                  </button>
                  {status === "Erreur." || status === "Annulé." ? <span className="muted">{status}</span> : null}
                </div>
              </div>
              <div className="card">
                <div style={{ fontWeight: 800 }}>Résultat</div>
                <div className="muted" style={{ marginTop: 4 }}>
                  Pages indexées: {result?.snapshot_stats?.total_pages ?? indexInfo?.total_pages ?? 0} · Catégories: {catCount}
                </div>
                {result?.snapshot_stats?.selected_categories?.length ? (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Catégories retenues: {result.snapshot_stats.selected_categories.join(", ")} · Pages candidates: {result.snapshot_stats.candidate_pages}
                  </div>
                ) : null}
                {Array.isArray(result?.snapshot_stats?.urls_sample) && result.snapshot_stats.urls_sample.length > 0 ? (
                  <div className="muted" style={{ marginTop: 6 }}>
                    URLs indexées (échantillon): {result.snapshot_stats.urls_sample.slice(0, 3).join(" | ")}
                  </div>
                ) : null}
                {busy && loadingAction ? (
                  <div className="loaderFancy">
                    <span className="loaderOrb" />
                    <div className="loaderText">
                      {loadingAction === "index"
                        ? "Indexation en cours... l'assistant prepare les pages."
                        : "Analyse en cours... l'assistant compare les contenus."}
                    </div>
                  </div>
                ) : (error || result) ? (
                  <div className="resultBox">
                    {error ? <pre>{escapeForText(error)}</pre> : (
                      <>
                        <div className="muted" style={{ marginBottom: 6 }}>Reponse assistant</div>
                        <pre>{escapeForText(result?.answer || result?.summary)}</pre>
                        {Array.isArray(result?.actions) && result.actions.length > 0 ? (
                          <pre style={{ marginTop: 8 }}>{result.actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}</pre>
                        ) : null}
                        <div className="muted" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <span>Issues: {issues.length}{frenchOnly && allIssues.length !== issues.length ? ` / ${allIssues.length} total` : ""}</span>
                          {allIssues.length > 0 && (
                            <button
                              type="button"
                              className="btn2"
                              style={{ padding: "4px 10px", fontSize: 12, borderRadius: 8 }}
                              onClick={() => setFrenchOnly((v) => !v)}
                            >
                              {frenchOnly ? "🌍 Voir toutes les langues" : "🇫🇷 Français uniquement"}
                            </button>
                          )}
                        </div>
{issues.map((it, i) => (
                          <div key={`${it?.url || "x"}-${i}`} className="issue">
                            <div><strong>{it?.severity?.toUpperCase() || "LOW"}</strong> · {it?.category || "autre"}</div>
                            <div className="muted">{it?.title || ""}</div>
                            <div className="muted" style={{ marginTop: 4 }}>
                              URL:{" "}
                              {it?.url ? (
                                <a href={it.url} target="_blank" rel="noreferrer" style={{ color: "#2563eb", textDecoration: "underline" }}>
                                  {it.url}
                                </a>
                              ) : (
                                "Non fournie"
                              )}
                            </div>
                            <pre style={{ marginTop: 8 }}>{escapeForText(it?.reason || "")}</pre>
                            {it?.evidence && (
                              <pre style={{ marginTop: 4, background: "#f0fdf4", borderColor: "#bbf7d0", fontSize: 12, color: "#166534" }}>
                                {escapeForText(it.evidence)}
                              </pre>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="resultBox"><span className="muted">Aucun résultat pour l'instant.</span></div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

