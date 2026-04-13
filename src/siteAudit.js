import OpenAI from "openai";
import { extractImageUrls, extractTextFromImages, createOCRWorker, terminateOCRWorker } from "./visionExtractor.js";

async function fetchHtml(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "GET", signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function extractYears(text) {
  const years = new Set();
  for (const m of String(text || "").matchAll(/\b(20\d{2})\b/g)) years.add(Number(m[1]));
  return [...years].sort((a, b) => a - b);
}

function extractNumbers(text) {
  const normalized = String(text || "").replace(/(\d)[\s\u00a0\u202f'](\d)/g, "$1$2");
  const out = new Set();
  for (const m of normalized.matchAll(/\b(\d{2,})\b/g)) {
    const v = Number(m[1]);
    if (v >= 10 && !/^20\d{2}$/.test(m[1])) out.add(v);
  }
  return [...out];
}

const STOPWORDS = new Set([
  "notre","nous","vous","leur","leurs","plus","mais","avec","pour","dans","sur","pas",
  "est","sont","tout","tous","cette","cest","cela","etre","avoir","faire","aussi",
  "tres","bien","moins","comme","quand","alors","donc","votre","vos","ses",
  "nouveau","nouvelle","maintenant","client","clients","service","services",
  "avons","avez","sommes","etes","font","peut","doit","faut","dont","quoi",
]);

function extractJsonObject(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/m, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return s.trim();
}

// ── Pre-filter: select candidate pages relevant to the query ─────────────────
// Keeps pages that mention at least 1 meaningful keyword from the query,
// or contain a number/year cited in the query.
// Returns at most maxPages, sorted by relevance score (desc).

function selectCandidates(compactPages, userUpdate, maxPages = 25) {
  const queryYears = extractYears(userUpdate);
  const queryNumbers = extractNumbers(userUpdate);
  const keywords = tokenize(userUpdate)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 15);

  if (!keywords.length && !queryYears.length && !queryNumbers.length) {
    // No signal → return most prominent pages (shortest URLs = home/sections)
    return [...compactPages]
      .sort((a, b) => {
        try { return new URL(a.url).pathname.length - new URL(b.url).pathname.length; }
        catch { return 0; }
      })
      .slice(0, maxPages);
  }

  const scored = compactPages.map((p) => {
    const full = norm(`${p.url} ${p.h1 || ""} ${p.title || ""} ${p.text_snippet || ""}`);
    const normSnippet = p.text_snippet
      ? p.text_snippet.replace(/(\d)[\s\u00a0\u202f'](\d)/g, "$1$2")
      : "";

    let score = 0;
    // Keyword hits (weighted by position: URL/H1 > snippet)
    for (const kw of keywords) {
      const inMeta = norm(`${p.url} ${p.h1 || ""}`).includes(kw);
      const inSnippet = full.includes(kw);
      if (inMeta) score += 3;
      else if (inSnippet) score += 1;
    }
    // Number hits
    for (const n of queryNumbers) {
      if (normSnippet.includes(String(n))) score += 2;
    }
    // Year hits
    for (const y of queryYears) {
      if (normSnippet.includes(String(y))) score += 2;
    }
    return { p, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages)
    .map((x) => x.p);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runExtiaSiteAudit({ userUpdate, siteIndex, openaiApiKey, model, visionEnabled = false }) {
  const allPages = Object.values(siteIndex?.grouped_pages || {}).flat();

  // Deduplicate by URL path (SPA variants share identical content)
  const seenPaths = new Set();
  const dedupedPages = [];
  for (const p of allPages) {
    let pathKey;
    try { pathKey = new URL(p.url).pathname; } catch { pathKey = p.url; }
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    dedupedPages.push(p);
  }

  const compactPages = dedupedPages.map((p) => ({
    url: p.url,
    category: p.category,
    title: p.title || "",
    h1: p.h1 || "",
    meta_description: p.meta_description || "",
    text_snippet: String(p.text_snippet || "").slice(0, 2000)
  }));

  // Step 1 — deterministic pre-filter
  const candidates = selectCandidates(compactPages, userUpdate, 25);

  // Step 1b — OCR enrichment on candidates only (fast: ~25 pages max)
  if (visionEnabled) {
    let ocrWorker = null;
    try {
      console.log(`[siteAudit] Starting OCR on ${candidates.length} candidate pages...`);
      ocrWorker = await createOCRWorker();
      for (const page of candidates) {
        try {
          const html = await fetchHtml(page.url, 10000);
          const imgUrls = extractImageUrls(html, page.url, 2);
          if (!imgUrls.length) continue;
          const imgText = await extractTextFromImages(imgUrls, ocrWorker);
          if (imgText) {
            page.text_snippet = (page.text_snippet + "\n[Images OCR]: " + imgText).slice(0, 3000);
          }
        } catch { /* skip — don't fail audit if OCR fails on one page */ }
      }
    } catch (e) {
      console.warn("[siteAudit] OCR init failed, skipping vision:", e?.message);
    } finally {
      await terminateOCRWorker(ocrWorker);
    }
  }

  // Step 2 — LLM validation
  const client = new OpenAI({ apiKey: openaiApiKey });

  const THIN_THRESHOLD = 300; // chars — below this, content is likely JS-rendered

  const pagesBlock = candidates.map((p, i) => {
    const thin = p.text_snippet.length < THIN_THRESHOLD;
    return `--- PAGE ${i + 1} ---\nURL: ${p.url}\nTitre: ${p.title}\nH1: ${p.h1}\n${thin ? "[CONTENU MINCE - probablement rendu via JavaScript, non capturé par l'indexeur]\n" : ""}Texte:\n${p.text_snippet}`;
  }).join("\n\n");

  const systemPrompt = [
    "Tu es un auditeur de contenu web. Tu analyses des pages d'un site d'entreprise pour détecter du contenu potentiellement obsolète par rapport à une mise à jour fournie par l'utilisateur.",
    "",
    "Règles STRICTES :",
    "- Ne signale une page QUE si (A) son texte contient une information qui CONTREDIT DIRECTEMENT la requête, OU (B) la page est clairement pertinente pour la requête (URL ou H1 correspond au sujet) mais marquée [CONTENU MINCE] — dans ce cas signale-la avec severity 'low' car son contenu dynamique n'a pas pu être vérifié.",
    "- Ne confonds PAS des métriques différentes : '46 agences' ne se compare pas à '2500 employés'. '700 membres d'une communauté gaming' n'est pas le total des employés.",
    "- Ignore les numéros de téléphone, codes postaux, numéros SIRET.",
    "- Si une page n'est pas pertinente à la requête ET n'a pas de contradiction, ne la signale PAS.",
    "- Pour chaque issue avec texte disponible, fournis une citation textuelle EXACTE. Pour les pages [CONTENU MINCE], indique 'Contenu chargé dynamiquement — vérification manuelle sur le site recommandée' comme evidence.",
    "- Réponds UNIQUEMENT en JSON strict, sans markdown. Premier caractère '{', dernier '}'.",
    "- Toutes les valeurs textuelles en français.",
    "",
    "Schéma de réponse :",
    JSON.stringify({
      summary: "Résumé en 1 phrase",
      issues: [{
        url: "url exacte de la page",
        title: "titre de la page",
        category: "catégorie",
        severity: "medium ou low",
        reason: "Explication courte de l'incohérence",
        evidence: "Citation textuelle exacte extraite de la page"
      }]
    }, null, 2)
  ].join("\n");

  const userPrompt = [
    `Mise à jour de l'utilisateur : "${userUpdate}"`,
    "",
    `${candidates.length} pages candidates à analyser :`,
    "",
    pagesBlock
  ].join("\n");

  let issues = [];
  let summary = "Aucune incohérence vérifiable détectée dans les pages indexées.";

  try {
    const response = await client.chat.completions.create({
      model: model || "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(extractJsonObject(raw));
    issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    if (parsed.summary) summary = parsed.summary;
  } catch (err) {
    console.error("[siteAudit] LLM error:", err?.message || err);
    summary = "Erreur lors de l'analyse IA. Vérifiez les logs.";
  }

  return {
    summary,
    issues,
    selection: {
      selected_categories: [...new Set(candidates.map((p) => p.category))],
      total_candidate_pages: candidates.length
    }
  };
}
