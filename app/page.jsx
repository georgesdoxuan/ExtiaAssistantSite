"use client";

import { useMemo, useRef, useState } from "react";

function escapeForText(s) {
  return String(s ?? "");
}

export default function Page() {
  // If NEXT_PUBLIC_API_BASE_URL is not set correctly, default to common local ports.
  // This prevents "Failed to fetch" when Express API and Next UI are on different ports.
  const API_BASE_URLS = process.env.NEXT_PUBLIC_API_BASE_URL
    ? ["", process.env.NEXT_PUBLIC_API_BASE_URL]
    : ["", "http://localhost:3001", "http://localhost:3000"];

  const [update, setUpdate] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const snapshotStats = result?.snapshot_stats || null;
  const topCampaignStatuses = useMemo(() => {
    if (!snapshotStats?.campaign_status_breakdown) return [];
    const entries = Object.entries(snapshotStats.campaign_status_breakdown);
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, 5).map(([k, v]) => `${k}: ${v}`);
  }, [snapshotStats]);


  const auditData = useMemo(() => {
    const summary = result?.answer || result?.summary || "";
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    const issues = findings.map((f) => ({
      severity: f?.severity || "low",
      reason: f?.reason || "",
      evidence: f?.evidence || "",
      workflow_title: f?.source?.workflow_title || "",
      email_title: f?.source?.email_title || "",
      email_id: f?.source?.email_id || "",
      title: f?.title || ""
    }));
    const counts = {
      high: issues.filter((i) => String(i?.severity || "").toLowerCase() === "high").length,
      medium: issues.filter((i) => String(i?.severity || "").toLowerCase() === "medium").length,
      low: issues.filter((i) => String(i?.severity || "").toLowerCase() === "low").length
    };
    return { summary, issues, counts };
  }, [result]);

  function badgeClass(sev) {
    const s = String(sev || "low").toLowerCase();
    if (s === "high") return "sev high";
    if (s === "medium") return "sev medium";
    return "sev low";
  }

  async function onRun() {
    const trimmed = String(update || "").trim();
    if (!trimmed) {
      setError(null);
      setStatus("Veuillez saisir un changement.");
      return;
    }

    setError(null);
    setResult(null);
    setStatus("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setStatus("Assistant Mailchimp en cours...");

      let lastErr = null;
      for (const baseUrl of API_BASE_URLS) {
        try {
          const target = baseUrl ? `${baseUrl}/api/mailchimp-assistant` : "/api/mailchimp-assistant";
          const resp = await fetch(target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: trimmed }),
            signal: controller.signal
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            throw new Error(data?.error || `Erreur API (${resp.status})`);
          }
          setResult(data);
          setStatus("Terminé.");
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (lastErr) {
        throw lastErr;
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        setStatus("Annulé.");
      } else {
        setError(e?.message || String(e));
        setStatus("Erreur.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onCancel() {
    abortRef.current?.abort();
  }

  function onClear() {
    setUpdate("");
    setResult(null);
    setError(null);
    setStatus("");
  }

  const kpiClass = useMemo(() => {
    if (!auditData.issues.length) return "dot";
    if (auditData.counts.high > 0) return "dot bad";
    if (auditData.counts.medium > 0) return "dot warn";
    return "dot good";
  }, [auditData]);

  const nav = [
    { href: "/", label: "Audit Mailchimp", active: true },
    { href: "/site-audit", label: "Audit site extia.fr", active: false }
  ];

  return (
    <>
      <style>{`
        :root{
          --bg: #f5f7fb;
          --card: rgba(255,255,255,0.9);
          --card-2: rgba(255,255,255,0.72);
          --text: #111827;
          --muted: #6b7280;
          --border: #e5e7eb;
          --shadow: 0 14px 40px rgba(17,24,39,0.08);
          --accent-2: #2563eb;
          --good: #16a34a;
          --warn: #d97706;
          --bad: #dc2626;
          --ring: rgba(124,58,237,0.25);
        }
        body{
          margin:0;
          color: var(--text);
          min-height: 100vh;
          background:
            radial-gradient(1000px 500px at 20% -10%, rgba(124,58,237,0.18), transparent 55%),
            radial-gradient(900px 450px at 90% 0%, rgba(37,99,235,0.14), transparent 60%),
            var(--bg);
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        }
        .wrap{
          max-width: 1260px;
          margin: 0 auto;
          padding: 26px 18px 48px;
        }
        .layout{
          display:grid;
          grid-template-columns: 240px 1fr;
          gap:16px;
          align-items:start;
        }
        @media (max-width: 980px){
          .layout{ grid-template-columns: 1fr; }
        }
        .sidebar{
          border: 1px solid var(--border);
          background: var(--card);
          border-radius: 16px;
          box-shadow: var(--shadow);
          backdrop-filter: blur(8px);
          padding: 12px;
          position: sticky;
          top: 16px;
        }
        .navItem{
          display:block;
          text-decoration:none;
          color: var(--text);
          border:1px solid transparent;
          padding:10px 12px;
          border-radius: 12px;
          margin-bottom: 8px;
          font-size: 14px;
        }
        .navItem:hover{ background:#eef2ff; border-color:#dbeafe; transform: translateX(2px); }
        .navItem.active{ background:#eef2ff; border-color:#bfdbfe; font-weight:700; }
        .content{ min-width:0; }
        .topbar{
          display:flex;
          gap:14px;
          align-items:center;
          justify-content:space-between;
          padding:18px 18px;
          border:1px solid var(--border);
          background: linear-gradient(135deg, rgba(124,58,237,0.16), rgba(37,99,235,0.1));
          border-radius: 16px;
          box-shadow: var(--shadow);
          backdrop-filter: blur(8px);
        }
        h1{ margin:0; font-size:18px; letter-spacing:0.2px; }
        .muted{ color: var(--muted); font-size:13px; }
        .grid{ display:grid; grid-template-columns: 1.1fr 0.9fr; gap: 16px; margin-top:16px; }
        @media (max-width: 900px){ .grid{ grid-template-columns: 1fr; } }
        .card{
          border: 1px solid var(--border);
          background: var(--card);
          border-radius: 16px;
          box-shadow: var(--shadow);
          padding: 16px;
          transition: transform .16s ease, box-shadow .16s ease;
        }
        .card:hover{ transform: translateY(-1px); box-shadow: 0 16px 44px rgba(17,24,39,0.11); }
        textarea{
          width:100%;
          height: 90px;
          min-height: 90px;
          max-height: 160px;
          font-size:14px;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          font-weight: 400;
          line-height: 1.35;
          border-radius:12px;
          padding:12px;
          border:1px solid var(--border);
          background: #ffffff;
          color: #111827;
          outline:none;
          resize: none;
          overflow: auto;
          box-sizing: border-box;
        }
        textarea:focus{
          border-color: rgba(124,58,237,0.65);
          box-shadow: 0 0 0 4px var(--ring);
        }
        .actions{ display:flex; gap:12px; align-items:center; margin-top:12px; flex-wrap: wrap; }
        button{
          padding:10px 14px;
          font-size:14px;
          cursor:pointer;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.18);
          background: linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.75));
          color:white;
          font-weight:650;
          transition: transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
          box-shadow: 0 8px 20px rgba(79,70,229,.22);
        }
        button:hover:not(:disabled){ transform: translateY(-1px); box-shadow: 0 12px 24px rgba(79,70,229,.28); }
        button:disabled{ cursor:not-allowed; filter: grayscale(0.4); opacity:0.7; }
        .btn-secondary{
          background: rgba(17,24,39,0.03);
          color: #111827;
          font-weight: 600;
        }
        .btn-cancel{
          background: linear-gradient(135deg, rgba(239,68,68,0.95), rgba(220,38,38,0.85));
          border-color: rgba(239,68,68,0.28);
          color:#fff;
        }
        .status{ font-size:13px; color: var(--muted); }
        .resultHead{ display:flex; gap:12px; align-items: baseline; justify-content: space-between; }
        .kpi{ display:inline-flex; align-items:center; gap:10px; font-weight:700; }
        .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
        .dot{
          width:10px; height:10px; border-radius:50%;
          box-shadow: 0 0 0 4px rgba(37,99,235,0.18);
          background: var(--accent-2);
        }
        .dot.good{ background: var(--good); box-shadow: 0 0 0 4px rgba(22,163,74,0.18); }
        .dot.warn{ background: var(--warn); box-shadow: 0 0 0 4px rgba(217,119,6,0.18); }
        .dot.bad{ background: var(--bad); box-shadow: 0 0 0 4px rgba(220,38,38,0.18); }
        .resultBox{
          margin-top:14px;
          border: 1px dashed rgba(17,24,39,0.18);
          border-radius:14px;
          padding:14px;
          background: var(--card-2);
        }
        .field{ margin-top: 8px; }
        .fieldLabel{ font-size:12px; color: var(--muted); margin-bottom:4px; }
        pre{
          margin:0;
          white-space: pre-wrap;
          word-break: break-word;
          padding:10px 12px;
          border-radius:12px;
          border: 1px solid var(--border);
          background: #f9fafb;
          font-size:13px;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          font-weight: 400;
        }
        .issues{ margin-top:12px; display:flex; flex-direction: column; gap: 10px; }
        .issueCard{
          border: 1px solid var(--border);
          background: #ffffff;
          border-radius:14px;
          padding:12px;
        }
        .issueTop{
          display:flex;
          gap:10px;
          align-items:center;
          justify-content:space-between;
          margin-bottom:8px;
        }
        .issueMeta{
          font-size: 12.5px;
          color: var(--muted);
          line-height: 1.35;
        }
        .sev{
          display:inline-flex;
          align-items:center;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 12px;
          border: 1px solid var(--border);
          font-weight: 750;
          letter-spacing: 0.2px;
        }
        .sev.high { background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.28); color: #b91c1c; }
        .sev.medium { background: rgba(217,119,6,0.10); border-color: rgba(217,119,6,0.26); color: #b45309; }
        .sev.low { background: rgba(22,163,74,0.08); border-color: rgba(22,163,74,0.26); color: #166534; }
        .spinner{
          width:16px; height:16px; border-radius:999px;
          border: 2px solid rgba(17,24,39,0.15);
          border-top-color: rgba(37,99,235,0.95);
          animation: spin 0.9s linear infinite;
          display:inline-block;
          vertical-align:-3px;
          margin-right: 8px;
        }
        .loaderFancy{
          margin-top: 14px;
          border: 1px dashed rgba(17,24,39,0.18);
          border-radius: 14px;
          padding: 18px 14px;
          background: linear-gradient(135deg, rgba(124,58,237,0.08), rgba(37,99,235,0.06));
          display:flex;
          align-items:center;
          gap: 12px;
        }
        .loaderOrb{
          width: 22px;
          height: 22px;
          border-radius: 999px;
          border: 3px solid rgba(37,99,235,0.2);
          border-top-color: rgba(124,58,237,0.95);
          animation: spin 0.8s linear infinite;
          box-shadow: 0 0 0 4px rgba(124,58,237,0.1);
        }
        .loaderText{ font-size: 13px; color: var(--muted); font-weight: 600; }
        @keyframes spin{ to{ transform: rotate(360deg); } }

        .aiIcon{
          width: 16px;
          height: 16px;
          display: inline-block;
          margin-right: 8px;
          vertical-align: -3px;
        }
      `}</style>

      <div className="wrap">
        <div className="layout">
        <aside className="sidebar">
          {nav.map((item) => (
            <a key={item.href} href={item.href} className={`navItem ${item.active ? "active" : ""}`}>
              {item.label}
            </a>
          ))}
        </aside>
        <div className="content">
        <div className="topbar">
          <div>
            <h1>Assistant Mailchimp (lecture seule) ✨</h1>
            <div className="muted" style={{ marginTop: 6 }}>
              Posez vos questions metier sur vos contenus Mailchimp.
              Aucune modification n'est possible (GET uniquement).
            </div>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <textarea
              id="update"
              placeholder="Ex: Trouve les emails Mailchimp qui contiennent encore les anciennes infos RH."
              value={update}
              onChange={(e) => setUpdate(e.target.value)}
              disabled={busy}
            />

            <div className="actions">
              <button onClick={busy ? onCancel : onRun} className={busy ? "btn-cancel" : ""}>
                {busy ? (
                  <>
                    <span className="spinner" />
                    Annuler
                  </>
                ) : (
                  <>
                    <span className="aiIcon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2l1.4 4.7L18 8l-4.6 1.3L12 14l-1.4-4.7L6 8l4.6-1.3L12 2Z" fill="rgba(255,255,255,0.95)"/>
                        <path d="M20 14l.9 3.1L24 18l-3.1.9L20 22l-.9-3.1L16 18l3.1-.9L20 14Z" fill="rgba(255,255,255,0.65)"/>
                        <path d="M5 12l.8 2.6L8.5 15l-2.7.8L5 18l-.8-2.2L1.5 15l2.7-.4L5 12Z" fill="rgba(255,255,255,0.55)"/>
                      </svg>
                    </span>
                    Envoyer a l'assistant
                  </>
                )}
              </button>
              {status === "Erreur." || status === "Annulé." ? <span className="status">{status}</span> : null}
              <button type="button" className="btn-secondary" onClick={onClear} disabled={busy}>
                Effacer
              </button>
            </div>

            <div className="muted" style={{ marginTop: 12 }}>
              Tip: si l’audit prend du temps, c’est normal (lecture Mailchimp + analyse IA).
            </div>
          </div>

          <div className="card">
            <div className="resultHead">
              <div>
                <div style={{ fontWeight: 800 }}>Résultat</div>
                <div className="muted" style={{ marginTop: 4 }}>
                  {result ? "Reponse assistant + preuves verifiables." : "Envoyez une question a l'assistant."}
                </div>
              </div>
              <div className="kpi">
                <span className={kpiClass} />
                <span className="mono">{result ? auditData.issues.length : "—"}</span>
              </div>
            </div>

            {busy ? (
              <div className="loaderFancy">
                <span className="loaderOrb" />
                <div className="loaderText">Analyse Mailchimp en cours... l'assistant verifie les contenus.</div>
              </div>
            ) : (result || error) ? (
              <div className="resultBox">
                {error ? (
                  <div className="field">
                    <div className="fieldLabel">Erreur</div>
                    <pre>{escapeForText(error)}</pre>
                  </div>
                ) : (
                  <>
                    {snapshotStats ? (
                      <div className="muted" style={{ marginBottom: 10 }}>
                        Snapshot Mailchimp : <span className="mono">{snapshotStats.workflows}</span> workflows ·{" "}
                        <span className="mono">{snapshotStats.emails}</span> emails ·{" "}
                        <span className="mono">{snapshotStats.scheduled_campaigns ?? 0}</span> campagnes planifiées ·{" "}
                        <span className="mono">{snapshotStats.draft_campaigns ?? 0}</span> brouillons audités
                        {topCampaignStatuses.length ? (
                          <div style={{ marginTop: 4 }}>
                            Statuts: <span className="mono">{topCampaignStatuses.join(" · ")}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="field">
                      <div className="fieldLabel">Reponse assistant</div>
                      <pre>{escapeForText(auditData.summary)}</pre>
                    </div>
                    {Array.isArray(result?.actions) && result.actions.length > 0 ? (
                      <div className="field">
                        <div className="fieldLabel">Actions recommandees</div>
                        <pre>{result.actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}</pre>
                      </div>
                    ) : null}

                    <div className="issues">
                      {auditData.issues.length === 0 ? (
                        <div className="issueCard">
                          <div style={{ fontWeight: 650 }} className="muted">
                            Aucune issue détectée.
                          </div>
                        </div>
                      ) : (
                        auditData.issues.map((issue, idx) => {
                          const sev = String(issue?.severity || "low");
                          return (
                            <div className="issueCard" key={`${issue?.email_id || "x"}-${idx}`}>
                              <div className="issueTop">
                                <span className={badgeClass(sev)}>
                                  {sev.toUpperCase()}
                                </span>
                                <div className="issueMeta">
                                  {issue?.workflow_title ? `Workflow: ${issue.workflow_title}` : null}
                                  {(issue?.email_title || issue?.email_id)
                                    ? `${issue?.workflow_title ? "\n" : ""}Email: ${issue.email_title || `(id: ${issue.email_id})`}`
                                    : null}
                                </div>
                              </div>
                              <div className="field">
                                <div className="fieldLabel">Raison</div>
                                <pre>{escapeForText(issue?.reason)}</pre>
                              </div>
                              <div className="field">
                                <div className="fieldLabel">Evidence</div>
                                <pre>{escapeForText(issue?.evidence)}</pre>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="resultBox" style={{ opacity: 0.7 }}>
                <div className="muted">Aucun résultat pour l’instant.</div>
              </div>
            )}
          </div>
        </div>
        </div>
        </div>
      </div>
    </>
  );
}

