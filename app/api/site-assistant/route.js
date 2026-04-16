import { runExtiaSiteAudit } from "../../../src/siteAudit.js";
import { buildExtiaSiteIndex, readExtiaSiteIndex } from "../../../src/siteIndexer.js";
import { ensureSupabaseSchema, isSupabaseConfigured, readIndexFromSupabase, writeIndexToSupabase } from "../../../src/supabaseIndexStore.js";
import { buildAssistantResponse, detectAssistantIntent, isThinContentIssue, requireEnv } from "../../../src/assistantCore.js";

function getApiBase() {
  return process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "";
}

export async function POST(request) {
  const apiBase = getApiBase();
  if (apiBase) {
    const body = await request.text();
    const resp = await fetch(`${apiBase}/api/site-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || "{}"
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") || "application/json" }
    });
  }

  try {
    const payload = await request.json().catch(() => ({}));
    const message = String(payload?.message ?? payload?.update ?? "").trim();
    if (!message) {
      return new Response(JSON.stringify({ error: "Missing 'message' field." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const openaiApiKey = requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const sourcePreference = (process.env.EXTIA_INDEX_STORAGE || "auto").toLowerCase();

    let index = null;
    if (sourcePreference !== "file" && isSupabaseConfigured()) {
      index = await readIndexFromSupabase();
    }
    if (!index) {
      try {
        index = await readExtiaSiteIndex();
      } catch (e) {
        if (String(e?.message || "").includes("ENOENT")) {
          index = await buildExtiaSiteIndex({
            maxUrls: Number(process.env.EXTIA_MAX_URLS || "300"),
            visionEnabled: process.env.EXTIA_VISION_ENABLED === "true"
          });
          if (isSupabaseConfigured()) {
            await ensureSupabaseSchema();
            await writeIndexToSupabase(index);
          }
        } else {
          throw e;
        }
      }
    }

    const audit = await runExtiaSiteAudit({
      openaiApiKey,
      model,
      userUpdate: message,
      siteIndex: index,
      visionEnabled: process.env.EXTIA_VISION_ENABLED === "true"
    });

    const intent = detectAssistantIntent(message);
    let effectiveIssues = Array.isArray(audit?.issues) ? audit.issues : [];
    let effectiveSummary = audit?.summary || "";

    if (intent === "advice") {
      effectiveIssues = [];
      effectiveSummary = "Demande orientee conseils detectee. Je fournis des recommandations prioritaires plutot qu'une liste d'incoherences.";
    } else {
      const strong = effectiveIssues.filter((it) => !isThinContentIssue(it));
      if (strong.length > 0) effectiveIssues = strong;
    }

    const snapshotStats = {
      total_pages: index?.total_pages || 0,
      categories: index?.categories?.length || 0,
      candidate_pages: audit?.selection?.total_candidate_pages || 0
    };

    const out = buildAssistantResponse({
      target: "site",
      userMessage: message,
      summary: effectiveSummary,
      issues: effectiveIssues,
      snapshotStats
    });

    if (intent === "advice") {
      out.actions = [
        "Prioriser 5 pages piliers (home, about-us, great-place-to-work, inside-extia, contact) et verifier la coherence des messages.",
        "Uniformiser les chiffres cles (annees, effectifs, agences) sur toutes les pages principales.",
        "Ajouter une date de mise a jour visible sur les pages corporate pour faciliter les revues futures.",
        "Mettre en place une routine mensuelle: indexation + revue des divergences detectees par l'assistant.",
        "Verifier manuellement les pages a contenu dynamique (widgets/jobs) qui peuvent echapper a l'indexeur texte."
      ];
      out.findings = [];
      out.confidence = "high";
    }

    return Response.json(out);
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

