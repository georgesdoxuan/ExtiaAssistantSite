import dotenv from "dotenv";
import express from "express";

import cors from "cors";
import fs from "node:fs";
import path from "node:path";

import { getAutomationsReadOnly, getScheduledCampaignsReadOnly, getAutomationFlowsReadOnly } from "./mailchimpClient.js";
import { probeAutomationFlowsListEndpointsReadOnly } from "./mailchimpClient.js";
import { runAuditWithOpenAI } from "./audit.js";
import { buildExtiaSiteIndex, readExtiaSiteIndex, getIndexPath } from "./siteIndexer.js";
import { runExtiaSiteAudit } from "./siteAudit.js";
import {
  ensureSupabaseSchema,
  isSupabaseConfigured,
  readIndexFromSupabase,
  writeIndexToSupabase
} from "./supabaseIndexStore.js";

// Load environment variables from `.env.local` (preferred) or fallback to `.env`.
// This matters because Next.js uses `.env.local`, while `dotenv/config` defaults to `.env`.
const envLocalPath = path.resolve(process.cwd(), ".env.local");
const envPath = path.resolve(process.cwd(), ".env");
const chosenPath = fs.existsSync(envLocalPath) ? envLocalPath : envPath;
dotenv.config({ path: chosenPath });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in environment.`);
  return value;
}

function buildAssistantResponse({ target, userMessage, summary, issues, snapshotStats }) {
  const findings = (Array.isArray(issues) ? issues : []).slice(0, 10).map((it) => ({
    severity: String(it?.severity || "low").toLowerCase(),
    title: it?.title || it?.category || "Point a verifier",
    reason: it?.reason || "",
    evidence: it?.evidence || "",
    source:
      target === "mailchimp"
        ? {
            workflow_title: it?.workflow_title || "",
            email_title: it?.email_title || "",
            email_id: it?.email_id || ""
          }
        : { url: it?.url || "", category: it?.category || "" }
  }));

  const hasFindings = findings.length > 0;
  const answer = hasFindings
    ? `J'ai analyse votre demande: "${userMessage}". ${summary} Je vous liste les points avec preuve ci-dessous.`
    : `J'ai analyse votre demande: "${userMessage}". ${summary} Aucun point incoherent verifiable n'a ete trouve.`;

  return {
    readonly_enforced: true,
    write_operations_attempted: 0,
    target,
    answer,
    findings,
    actions: hasFindings
      ? [
          "Verifier les elements cites avec les equipes metier.",
          "Mettre a jour les contenus identifies dans votre outil source (manuellement).",
          "Relancer l'assistant pour confirmer que les incoherences ont disparu."
        ]
      : ["Aucune action urgente. Surveillez les prochaines mises a jour avec cette meme requete."],
    limitations: [
      "Mode strict lecture seule: aucune modification automatique n'est effectuee.",
      "Les conclusions sont basees uniquement sur les contenus accessibles via les APIs/URLs disponibles."
    ],
    confidence: hasFindings ? "medium" : "high",
    snapshot_stats: snapshotStats || {}
  };
}

function detectAssistantIntent(message) {
  const t = String(message || "").toLowerCase();
  if (/\b(conseil|conseils|recommand|am[eé]lior|optimis|best practice|strategie)\b/.test(t)) {
    return "advice";
  }
  return "audit";
}

function detectMailchimpIntent(message) {
  const t = String(message || "").toLowerCase();
  if (/\b(signification|veut dire|definition|c[' ]?est quoi|meaning|explique)\b/.test(t)) {
    return "explain_api_terms";
  }
  if (
    /\b(dernier|plus recent|latest)\b/.test(t) &&
    /\b(programm|planifi|schedule|scheduled)\b/.test(t)
  ) {
    return "latest_scheduled";
  }
  return "audit";
}

function getMailchimpApiDictionary() {
  return {
    campaign_types: {
      scheduled_campaign: "Campagne programmee avec une date/heure d'envoi (send_time).",
      draft_campaign: "Brouillon (status souvent 'save'), non programme tant qu'aucun send_time futur n'est defini.",
      automation_flow: "Flow/Journey d'automation (Customer Journey)."
    },
    status_common_meaning: {
      save: "Brouillon non envoye. Ce statut seul ne prouve pas une programmation.",
      schedule: "Campagne planifiee pour envoi futur.",
      scheduled: "Equivalent de schedule (selon endpoint/version).",
      sending: "En cours d'envoi.",
      sent: "Deja envoye.",
      canceled: "Envoi annule.",
      archived: "Archive/inactive."
    },
    time_fields: {
      send_time: "Date/heure d'envoi retenue en priorite pour determiner si une campagne est programmee.",
      scheduled_time: "Variante possible selon endpoint.",
      schedule_time: "Variante possible selon endpoint.",
      settings_send_time: "Variante dans settings.",
      settings_scheduled_time: "Variante dans settings.",
      settings_schedule_time: "Variante dans settings."
    },
    rules_used_by_assistant: [
      "Une campagne est consideree 'programmee' seulement si type/status est schedule/scheduled ET date d'envoi future valide.",
      "Un brouillon 'save' sans date d'envoi future n'est pas considere programme.",
      "Mode lecture seule strict: aucune operation d'ecriture API n'est effectuee."
    ]
  };
}

function isThinContentIssue(issue) {
  const reason = String(issue?.reason || "").toLowerCase();
  const evidence = String(issue?.evidence || "").toLowerCase();
  return (
    reason.includes("contenu mince") ||
    reason.includes("charg") && reason.includes("dynami") ||
    evidence.includes("charg") && evidence.includes("dynami")
  );
}

const app = express();
app.use(express.json({ limit: "1mb" }));
// Minimal request logger (helps debug "Indexer" / "Audit" clicks).
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    // Log only method/path/status/duration (no headers/body to avoid leaking secrets).
    console.log(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});
// Dev only: allow browser UI on localhost to call the audit API.
const corsOptions = {
  origin: (origin, callback) => {
    // No Origin header (e.g. curl / server-to-server) => allow.
    if (!origin) return callback(null, true);
    const allowed =
      /^http:\/\/localhost:\d+$/i.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin);
    return callback(null, allowed);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
// Make preflight handling explicit (some browsers are picky).
app.options("*", cors(corsOptions));
// UI served by Next.js. This backend only exposes the audit API.
app.get("/", (_req, res) => {
  res.status(404).json({ error: "UI is served by Next.js. Use POST /api/audit." });
});

app.post("/api/audit", async (req, res) => {
  try {
    const businessUpdate = String(req.body?.update ?? "").trim();
    if (!businessUpdate) {
      res.status(400).json({ error: "Missing 'update' field." });
      return;
    }

    // Enforce read-only mode at app level too.
    const mode = (process.env.MAILCHIMP_MODE || "readonly").toLowerCase();
    if (mode !== "readonly") {
      res.status(400).json({ error: 'MAILCHIMP_MODE must be "readonly".' });
      return;
    }

    const mailchimpApiKey = requireEnv("MAILCHIMP_API_KEY");
    const openaiApiKey = requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const workflowsCount = Number(process.env.MAILCHIMP_WORKFLOWS_COUNT || "200");
    const campaignsCount = Number(process.env.MAILCHIMP_CAMPAIGNS_COUNT || "200");
    // Default: audit all matching scheduled campaigns (bounded by MAILCHIMP_CAMPAIGNS_COUNT and response size).
    // You can lower this if you want to reduce cost/time.
    const maxCampaignsToAudit = Number(process.env.MAILCHIMP_MAX_CAMPAIGNS_TO_AUDIT || "200");

    const [automations, scheduledCampaigns] = await Promise.all([
      getAutomationsReadOnly(mailchimpApiKey, workflowsCount),
      getScheduledCampaignsReadOnly(mailchimpApiKey, campaignsCount, maxCampaignsToAudit)
    ]);

    const automationFlows = await getAutomationFlowsReadOnly(
      mailchimpApiKey,
      Number(process.env.MAILCHIMP_FLOWS_COUNT || "200"),
      Number(process.env.MAILCHIMP_MAX_FLOWS_TO_AUDIT || "20")
    );

    const noAutomations = (automations?.total_emails ?? 0) === 0;
    const noCampaigns = (scheduledCampaigns?.campaigns?.length ?? 0) === 0;
    const noAutomationFlows = (automationFlows?.flows?.length ?? 0) === 0;
    const noAuditableContent = noAutomations && noCampaigns && noAutomationFlows;

    let audit;
    if (noAuditableContent) {
      // Deterministic output when there is nothing to audit, to avoid LLM false positives.
      audit = {
        summary:
          "Aucun contenu auditable n'a été trouvé (0 email d'automation, 0 campagne planifiée ou brouillon, 0 automation flow).",
        issues: []
      };
    } else {
      audit = await runAuditWithOpenAI({
        openaiApiKey,
        model,
        businessUpdate,
        automations,
        scheduledCampaigns,
        automationFlows
      });
    }

    const allCampaigns = scheduledCampaigns?.campaigns ?? [];
    const scheduledCount = allCampaigns.filter((c) => c.type === "scheduled_campaign").length;
    const draftCount = allCampaigns.filter((c) => c.type === "draft_campaign").length;

    res.json({
      ...audit,
      snapshot_stats: {
        workflows: automations?.total_items ?? automations?.workflows?.length ?? 0,
        emails: automations?.total_emails ?? 0,
        scheduled_campaigns: scheduledCount,
        draft_campaigns: draftCount,
        campaigns_audited: allCampaigns.length,
        campaigns_fetched: scheduledCampaigns?.total_campaigns_fetched ?? 0,
        campaign_status_breakdown: scheduledCampaigns?.status_breakdown ?? {},
        campaigns_candidates_for_detail: scheduledCampaigns?.total_campaigns_candidates_for_detail ?? 0,
        debug_save_campaign_samples: scheduledCampaigns?.debug_save_campaign_samples ?? [],
        automation_flows_selected: automationFlows?.total_flows_selected ?? 0,
        automation_flows_fetched: automationFlows?.total_flows_fetched ?? 0,
        automation_flows_list_probe: automationFlows?.list_probe ?? []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/mailchimp-assistant", async (req, res) => {
  try {
    const message = String(req.body?.message ?? req.body?.update ?? "").trim();
    if (!message) {
      res.status(400).json({ error: "Missing 'message' field." });
      return;
    }

    const mode = (process.env.MAILCHIMP_MODE || "readonly").toLowerCase();
    if (mode !== "readonly") {
      res.status(400).json({ error: 'MAILCHIMP_MODE must be "readonly".' });
      return;
    }

    const mailchimpApiKey = requireEnv("MAILCHIMP_API_KEY");
    const openaiApiKey = requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const workflowsCount = Number(process.env.MAILCHIMP_WORKFLOWS_COUNT || "200");
    const campaignsCount = Number(process.env.MAILCHIMP_CAMPAIGNS_COUNT || "200");
    const maxCampaignsToAudit = Number(process.env.MAILCHIMP_MAX_CAMPAIGNS_TO_AUDIT || "200");

    const [automations, scheduledCampaigns] = await Promise.all([
      getAutomationsReadOnly(mailchimpApiKey, workflowsCount),
      getScheduledCampaignsReadOnly(mailchimpApiKey, campaignsCount, maxCampaignsToAudit)
    ]);

    const automationFlows = await getAutomationFlowsReadOnly(
      mailchimpApiKey,
      Number(process.env.MAILCHIMP_FLOWS_COUNT || "200"),
      Number(process.env.MAILCHIMP_MAX_FLOWS_TO_AUDIT || "20")
    );

    const noAutomations = (automations?.total_emails ?? 0) === 0;
    const noCampaigns = (scheduledCampaigns?.campaigns?.length ?? 0) === 0;
    const noAutomationFlows = (automationFlows?.flows?.length ?? 0) === 0;
    const noAuditableContent = noAutomations && noCampaigns && noAutomationFlows;
    const mailchimpIntent = detectMailchimpIntent(message);

    const allCampaigns = scheduledCampaigns?.campaigns ?? [];
    const scheduledOnly = allCampaigns
      .filter((c) => c.type === "scheduled_campaign" && c.send_time)
      .sort((a, b) => Date.parse(String(b.send_time || 0)) - Date.parse(String(a.send_time || 0)));

    const snapshotStats = {
      workflows: automations?.total_items ?? automations?.workflows?.length ?? 0,
      emails: automations?.total_emails ?? 0,
      scheduled_campaigns: allCampaigns.filter((c) => c.type === "scheduled_campaign").length,
      draft_campaigns: allCampaigns.filter((c) => c.type === "draft_campaign").length,
      campaigns_audited: allCampaigns.length
    };

    if (mailchimpIntent === "latest_scheduled") {
      if (scheduledOnly.length === 0) {
        res.json({
          readonly_enforced: true,
          write_operations_attempted: 0,
          target: "mailchimp",
          answer:
            "Aucun mail n'est actuellement programme pour un envoi futur dans les donnees Mailchimp disponibles.",
          findings: [],
          actions: [
            "Verifier dans Mailchimp les campagnes au statut 'schedule/scheduled'.",
            "Verifier que la date d'envoi est bien renseignee (send_time)."
          ],
          limitations: [
            "Les campagnes en brouillon (status 'save') ne sont pas considerees comme programmees.",
            "Mode lecture seule strict: aucune modification automatique."
          ],
          confidence: "high",
          snapshot_stats: snapshotStats
        });
      } else {
        const latest = scheduledOnly[0];
        res.json({
          readonly_enforced: true,
          write_operations_attempted: 0,
          target: "mailchimp",
          answer: `Le dernier mail programme est "${latest.name || "(sans titre)"}", prevu pour ${latest.send_time}.`,
          findings: [
            {
              severity: "low",
              title: latest.name || "(sans titre)",
              reason: "Campagne planifiee detectee avec date d'envoi future.",
              evidence: `status=${latest.status || "unknown"} ; send_time=${latest.send_time || ""}`,
              source: {
                workflow_title: "",
                email_title: latest.name || "",
                email_id: latest.id || ""
              }
            }
          ],
          actions: ["Verifier que le contenu et l'objet sont bien a jour avant l'envoi."],
          limitations: ["Mode lecture seule strict: aucune modification automatique."],
          confidence: "high",
          snapshot_stats: snapshotStats
        });
      }
      return;
    }

    if (mailchimpIntent === "explain_api_terms") {
      res.json({
        readonly_enforced: true,
        write_operations_attempted: 0,
        target: "mailchimp",
        answer: "Voici les significations principales des ecritures/champs API Mailchimp utilises par l'assistant.",
        findings: [],
        actions: ["Utiliser ces definitions comme reference pour interpreter les resultats."],
        limitations: ["Les noms exacts peuvent varier selon endpoint/version Mailchimp."],
        confidence: "high",
        api_dictionary: getMailchimpApiDictionary(),
        snapshot_stats: snapshotStats
      });
      return;
    }

    let audit;
    if (noAuditableContent) {
      audit = {
        summary: "Aucun contenu auditable n'a ete trouve (automations/campagnes/flows).",
        issues: []
      };
    } else {
      audit = await runAuditWithOpenAI({
        openaiApiKey,
        model,
        businessUpdate: message,
        automations,
        scheduledCampaigns,
        automationFlows
      });
    }

    const base = buildAssistantResponse({
      target: "mailchimp",
      userMessage: message,
      summary: audit?.summary || "",
      issues: audit?.issues || [],
      snapshotStats
    });
    base.api_dictionary = getMailchimpApiDictionary();
    res.json(base);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/site-index/refresh", async (req, res) => {
  // Increase socket timeout for long indexing jobs (200+ URLs).
  req.socket.setTimeout(9 * 60 * 1000);
  res.setTimeout(9 * 60 * 1000);

  try {
    const maxUrls = Number(req.body?.maxUrls || process.env.EXTIA_MAX_URLS || "300");
    const forceBrowser = req.body?.forceBrowser === true;
    const visionEnabled = process.env.EXTIA_VISION_ENABLED === "true";
    console.log(`[API] site-index/refresh: maxUrls=${maxUrls} forceBrowser=${forceBrowser} vision=${visionEnabled}`);
    const index = await buildExtiaSiteIndex({ maxUrls, forceBrowser, visionEnabled });
    let stored_in = "file";
    if (isSupabaseConfigured()) {
      await ensureSupabaseSchema();
      await writeIndexToSupabase(index);
      stored_in = "file+supabase";
    }
    console.log(`[API] site-index/refresh done: ${index.total_pages} pages, ${index.total_errors} errors, stored=${stored_in}`);
    res.json({
      ok: true,
      total_pages: index.total_pages,
      total_errors: index.total_errors,
      categories: index.categories,
      stored_in
    });
  } catch (err) {
    console.error(`[API] site-index/refresh error:`, err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get("/api/site-index/status", async (_req, res) => {
  try {
    const sourcePreference = (process.env.EXTIA_INDEX_STORAGE || "auto").toLowerCase();
    let index = null;
    let source = "file";
    if (sourcePreference !== "file" && isSupabaseConfigured()) {
      index = await readIndexFromSupabase();
      if (index) source = "supabase";
    }
    if (!index) index = await readExtiaSiteIndex();

    res.json({
      ok: true,
      index_path: getIndexPath(),
      built_at: index.built_at,
      total_pages: index.total_pages,
      total_errors: index.total_errors,
      categories: index.categories,
      source
    });
  } catch (err) {
    res.status(404).json({ ok: false, error: "Index introuvable. Lancez un refresh." });
  }
});

app.post("/api/site-audit", async (req, res) => {
  try {
    const userUpdate = String(req.body?.update ?? "").trim();
    if (!userUpdate) {
      res.status(400).json({ error: "Missing 'update' field." });
      return;
    }

    const openaiApiKey = requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    const sourcePreference = (process.env.EXTIA_INDEX_STORAGE || "auto").toLowerCase();
    let index = null;
    let indexSource = "file";
    if (sourcePreference !== "file" && isSupabaseConfigured()) {
      index = await readIndexFromSupabase();
      if (index) indexSource = "supabase";
    }
    if (!index) {
      try {
        index = await readExtiaSiteIndex();
      } catch (e) {
        // Auto-bootstrap index on first run to avoid ENOENT.
        if (String(e?.message || "").includes("ENOENT")) {
          index = await buildExtiaSiteIndex({
            maxUrls: Number(process.env.EXTIA_MAX_URLS || "300"),
            visionEnabled: process.env.EXTIA_VISION_ENABLED === "true"
          });
          if (isSupabaseConfigured()) {
            await ensureSupabaseSchema();
            await writeIndexToSupabase(index);
            indexSource = "file+supabase";
          }
        } else {
          throw e;
        }
      }
    }

    // If index is too small, refresh automatically to avoid low-quality audits.
    const minPages = Number(process.env.EXTIA_MIN_PAGES_FOR_AUDIT || "20");
    if ((index?.total_pages || 0) < minPages) {
      index = await buildExtiaSiteIndex({
        maxUrls: Number(process.env.EXTIA_MAX_URLS || "300"),
        openaiApiKey: process.env.OPENAI_API_KEY || null,
        visionEnabled: process.env.EXTIA_VISION_ENABLED === "true"
      });
      if (isSupabaseConfigured()) {
        await ensureSupabaseSchema();
        await writeIndexToSupabase(index);
        indexSource = "file+supabase";
      } else {
        indexSource = "file";
      }
    }

    const visionEnabled = process.env.EXTIA_VISION_ENABLED === "true";
    const audit = await runExtiaSiteAudit({
      openaiApiKey,
      model,
      userUpdate,
      siteIndex: index,
      visionEnabled
    });

    res.json({
      ...audit,
      snapshot_stats: {
        built_at: index.built_at,
        total_pages: index.total_pages,
        categories: index.categories?.length || 0,
        selected_categories: audit?.selection?.selected_categories || [],
        candidate_pages: audit?.selection?.total_candidate_pages || 0,
        index_source: indexSource,
        urls_sample: Object.values(index?.grouped_pages || {})
          .flat()
          .slice(0, 10)
          .map((p) => p.url)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/site-assistant", async (req, res) => {
  try {
    const message = String(req.body?.message ?? req.body?.update ?? "").trim();
    if (!message) {
      res.status(400).json({ error: "Missing 'message' field." });
      return;
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
      // For "conseils" queries, avoid noisy mismatch findings and give actionable guidance.
      effectiveIssues = [];
      effectiveSummary =
        "Demande orientee conseils detectee. Je fournis des recommandations prioritaires plutot qu'une liste d'incoherences.";
    } else {
      // In audit intent, filter out ultra-weak thin-content placeholders unless they are the only signal.
      const strong = effectiveIssues.filter((it) => !isThinContentIssue(it));
      if (strong.length > 0) {
        effectiveIssues = strong;
      }
    }

    const snapshotStats = {
      total_pages: index?.total_pages || 0,
      categories: index?.categories?.length || 0,
      candidate_pages: audit?.selection?.total_candidate_pages || 0
    };
    const base = buildAssistantResponse({
      target: "site",
      userMessage: message,
      summary: effectiveSummary,
      issues: effectiveIssues,
      snapshotStats
    });

    if (intent === "advice") {
      base.actions = [
        "Prioriser 5 pages piliers (home, about-us, great-place-to-work, inside-extia, contact) et verifier la coherence des messages.",
        "Uniformiser les chiffres cles (annees, effectifs, agences) sur toutes les pages principales.",
        "Ajouter une date de mise a jour visible sur les pages corporate pour faciliter les revues futures.",
        "Mettre en place une routine mensuelle: indexation + revue des divergences detectees par l'assistant.",
        "Verifier manuellement les pages a contenu dynamique (widgets/jobs) qui peuvent echapper a l'indexeur texte."
      ];
      base.findings = [];
      base.confidence = "high";
    }

    res.json(base);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Backward-compatible aliases (same behavior)
app.post("/api/site/index/refresh", async (req, res) => {
  req.url = "/api/site-index/refresh";
  app._router.handle(req, res, () => {});
});

app.get("/api/site/index/status", async (req, res) => {
  req.url = "/api/site-index/status";
  app._router.handle(req, res, () => {});
});

app.post("/api/site/audit", async (req, res) => {
  req.url = "/api/site-audit";
  app._router.handle(req, res, () => {});
});

// Debug-only: probes read-only GET endpoints for Automation flows listing.
// Does not modify or delete anything in Mailchimp.
app.get("/api/debug/probe-automation-flows", async (_req, res) => {
  try {
    const mailchimpApiKey = requireEnv("MAILCHIMP_API_KEY");
    const probe = await probeAutomationFlowsListEndpointsReadOnly(mailchimpApiKey, 50);
    res.json(probe);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

const port = Number(process.env.PORT || "3000");
app.listen(port, () => {
  // Avoid logging secrets; these are safe.
  console.log(`Audit API running at http://localhost:${port}`);
});

